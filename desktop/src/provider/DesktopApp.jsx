// S2/S3：桌面 Provider 与「角色/会话/聊天」最小闭环界面。
//
// 三个 Provider 全部**逐字复用** src/ 的实现（单一事实源）：
// - I18nProvider / ThemeProvider / AppProvider 只依赖 storage 与 i18n 纯逻辑，
//   平台差异由 vite 别名 + 适配层吸收（见 vite.config.mjs）。
// 聊天编排复用 useSessionMessages + useChatSend（desktop/src/provider/useDesktopChat.js），
// 保留配置指纹校验、迟到回复丢弃、串行落盘与草稿恢复等既有语义。
//
// 界面只做桌面首版所需：角色列表 / 会话列表 / 文本收发（流式）/ 重新生成 /
// 语言与主题切换 / 应用内 Alert；正文渲染（Markdown/富 HTML/媒体）见 render/。
// 附件与表情包发送在 S4b 接入。
import { useEffect, useMemo, useRef, useState } from 'react';

import { AppProvider, useApp } from '../../../src/context/AppContext.js';
import { I18nProvider, useTranslation } from '../../../src/i18n/I18nContext.js';
import { ThemeProvider, useTheme } from '../../../src/theme/ThemeContext.js';
import { mediaUrl } from '../platform/mediaUrl.js';
import { resolveAlert, subscribeAlert, Alert } from '../platform/alert.js';
import { getBridge } from '../platform/bridge.js';
import {
  acknowledgeDisclaimer,
  completeOnboarding,
  isDisclaimerAcknowledged,
  isOnboardingDone,
} from '../../../src/storage/settings.js';
import BackupPanel from '../backup/BackupPanel.jsx';
import { applyCharacterCard, pickCharacterCard } from '../backup/services.js';
import CharacterEditScreen from '../character/CharacterEditScreen.jsx';
import CharacterLibraryScreen from '../character/CharacterLibraryScreen.jsx';
import ExtensionScreen from '../extension/ExtensionScreen.jsx';
import MemoryScreen from '../memory/MemoryScreen.jsx';
import DisclaimerDialog from '../settings/DisclaimerDialog.jsx';
import SettingsScreen from '../settings/SettingsScreen.jsx';
import TutorialDialog from '../settings/TutorialDialog.jsx';
import ChatPane from './ChatPane.jsx';
import SessionsPanel from './SessionsPanel.jsx';

const DEFAULT_NEW_CHARACTER = {
  name: 'New Character',
  description: '',
  personality: '',
  scenario: '',
  systemPrompt: '',
  firstMes: '',
  alternateGreetings: [],
  examples: '',
  tags: [],
  lorebook: [],
  regex: [],
};

function Avatar({ uri, name, size = 40 }) {
  const src = useMemo(() => (uri ? mediaUrl(uri) : null), [uri]);
  if (src) {
    return <img src={src} alt="" style={{ width: size, height: size, borderRadius: size / 2, objectFit: 'cover', flex: 'none' }} />;
  }
  return (
    <div style={{
      width: size,
      height: size,
      borderRadius: size / 2,
      flex: 'none',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#2a2f3d',
      color: '#9aa3b5',
      fontSize: size * 0.42,
      fontWeight: 700,
    }}
    >
      {String(name || '?').slice(0, 1).toUpperCase()}
    </div>
  );
}

// 应用内 Alert（共享层 Alert.alert 的落点；桌面无原生弹窗）。
function AlertHost({ palette, fonts }) {
  const [alert, setAlert] = useState(null);
  useEffect(() => subscribeAlert(setAlert), []);
  if (!alert) return null;
  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      background: 'rgba(0,0,0,0.55)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 50,
    }}
    >
      <div style={{
        width: 'min(440px, 90vw)',
        background: palette.surface,
        border: `1px solid ${palette.divider}`,
        borderRadius: 12,
        padding: 20,
        color: palette.text,
      }}
      >
        {alert.title ? <div style={{ fontWeight: 800, fontSize: fonts.scaled(15), marginBottom: 8 }}>{alert.title}</div> : null}
        {alert.message ? <div style={{ color: palette.textMuted, fontSize: fonts.scaled(13), lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{alert.message}</div> : null}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          {alert.buttons.map((button, index) => (
            <button
              key={`${button.text}-${index}`}
              type="button"
              onClick={() => resolveAlert(index)}
              style={{
                background: button.style === 'cancel' ? 'transparent' : palette.primary,
                color: button.style === 'cancel' ? palette.textMuted : palette.primaryContrast,
                border: button.style === 'cancel' ? `1px solid ${palette.divider}` : 'none',
                borderRadius: 8,
                padding: '8px 14px',
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              {button.text}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function Shell() {
  const { t, localeId, setLocaleId } = useTranslation();
  const { theme, fonts, themeId, setThemeId, themes } = useTheme();
  const {
    characters,
    activeId,
    sessions,
    activeSessionId,
    loaded,
    startupError,
    switchCharacter,
    addCharacter,
    deleteCharacter,
    ensureCharacterSession,
    switchSession,
    deleteSession,
    pinSession,
    cloneSession,
    refreshSessions,
    updateCharacter,
    pinCharacter,
    refreshAppData,
  } = useApp();
  const [busy, setBusy] = useState('');
  const [showSessions, setShowSessions] = useState(false);
  const [showBackup, setShowBackup] = useState(false);
  const [view, setView] = useState('chat');
  // 角色库页（卡片网格）与角色编辑页分开：库页是「选谁」，编辑页是「改什么」。
  const [characterScreen, setCharacterScreen] = useState('library');
  const [showTutorial, setShowTutorial] = useState(false);
  const [showDisclaimer, setShowDisclaimer] = useState(false);
  const [firstRunStage, setFirstRunStage] = useState('loading');
  const [appVersion, setAppVersion] = useState('');
  const ensuredRef = useRef(false);

  // 首启门禁：未同意免责条款先看免责声明，同意了但没看完教程再看教程（与 App.js
  // StartupFlow 同一顺序），完成后才允许进入主界面。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const acknowledged = await isDisclaimerAcknowledged();
        if (cancelled) return;
        if (!acknowledged) {
          setFirstRunStage('disclaimer');
          return;
        }
        const done = await isOnboardingDone();
        if (cancelled) return;
        setFirstRunStage(done ? 'done' : 'onboarding');
      } catch (error) {
        if (!cancelled) setFirstRunStage('disclaimer');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    getBridge().app.info()
      .then(info => setAppVersion(String((info && info.version) || '')))
      .catch(() => {});
  }, []);

  const activeCharacter = characters.find(character => character.id === activeId) || null;
  const characterSessions = useMemo(
    () => sessions.filter(session => session.characterId === activeId),
    [sessions, activeId]
  );

  useEffect(() => {
    if (!loaded || ensuredRef.current || !activeCharacter) return;
    ensuredRef.current = true;
    if (!sessions.some(session => session.characterId === activeId)) {
      ensureCharacterSession(activeId).catch(() => {});
    }
  }, [loaded, activeCharacter, sessions, activeId, ensureCharacterSession]);

  useEffect(() => {
    if (!loaded) return;
    globalThis.__easychat2S2 = {
      loaded,
      counts: { characters: characters.length, sessions: sessions.length },
      activeId,
      activeSessionId,
    };
  }, [loaded, characters.length, sessions.length, activeId, activeSessionId]);

  const run = async (name, action) => {
    setBusy(name);
    try {
      await action();
    } finally {
      setBusy('');
    }
  };

  // 角色卡导入（角色库页入口）：解析成功才落库；错误按「过大 / 解析失败 / 其它」分档。
  const importCard = async () => {
    if (busy) return;
    setBusy('importCard');
    try {
      const picked = await pickCharacterCard();
      if (picked.canceled) return;
      if (picked.empty) {
        Alert.alert(t('character.detail.importEmpty.title'), t('character.detail.importEmpty.body'));
        return;
      }
      const applied = await applyCharacterCard(picked, {
        addCharacter,
        ensureCharacterSession,
        updateCharacter,
      });
      Alert.alert(
        t('character.detail.importOk.title'),
        t('backup.card.importDone', {
          name: (applied.created && applied.created.name) || picked.patch.name || '',
        })
      );
      setCharacterScreen('library');
    } catch (error) {
      if (error && error.code === 'TOO_LARGE') {
        Alert.alert(
          t('character.detail.importTooLarge.title'),
          t('character.detail.importTooLarge.body', { size: '32 MB' })
        );
      } else if (error && error.code === 'PARSE') {
        Alert.alert(
          t('character.detail.importParseFail.title'),
          error.detail || t('character.detail.importParseFail.fallback')
        );
      } else {
        Alert.alert(
          t('character.detail.importFail.title'),
          String((error && error.message) || t('common.error.retryLater'))
        );
      }
    } finally {
      setBusy('');
    }
  };

  const palette = theme.colors;
  const page = {
    height: '100vh',
    display: 'flex',
    background: palette.background,
    color: palette.text,
    fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans SC", sans-serif',
    overflow: 'hidden',
  };
  const sidebar = {
    width: 288,
    flex: 'none',
    borderRight: `1px solid ${palette.divider}`,
    display: 'flex',
    flexDirection: 'column',
    background: palette.surface,
  };
  const row = { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderRadius: 10 };
  const ghost = {
    background: 'transparent',
    color: palette.textMuted,
    border: `1px solid ${palette.divider}`,
    borderRadius: 8,
    padding: '6px 10px',
    cursor: 'pointer',
    fontSize: fonts.scaled(12),
  };

  return (
    <div style={page}>
      <aside style={sidebar}>
        <div style={{ padding: '14px 16px 8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <strong style={{ fontSize: fonts.scaled(15) }}>{t('app.tab.character')}</strong>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              type="button"
              style={ghost}
              title={t('character.library.cardTitle')}
              onClick={() => {
                setCharacterScreen('library');
                setView('character');
                setShowSessions(false);
                setShowBackup(false);
              }}
            >
              ☰
            </button>
            <button type="button" style={ghost} disabled={!!busy} onClick={() => run('add', () => addCharacter(DEFAULT_NEW_CHARACTER))}>
              +
            </button>
          </div>
        </div>
        <div style={{ overflow: 'auto', flex: 1, padding: '0 8px 12px' }}>
          {characters.map(character => (
            <div
              key={character.id}
              role="button"
              tabIndex={0}
              onClick={() => switchCharacter(character.id)}
              onKeyDown={event => { if (event.key === 'Enter') switchCharacter(character.id); }}
              style={{
                ...row,
                cursor: 'pointer',
                background: character.id === activeId ? palette.surfaceAlt : 'transparent',
                border: `1px solid ${character.id === activeId ? palette.primaryMuted : 'transparent'}`,
                marginBottom: 4,
              }}
            >
              <Avatar uri={character.avatarUri} name={character.name} />
              <span style={{ flex: 1, fontSize: fonts.scaled(13), overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {character.name || '—'}
              </span>
              <button
                type="button"
                style={{ ...ghost, padding: '2px 8px' }}
                disabled={!!busy}
                onClick={event => {
                  event.stopPropagation();
                  run('delete', () => deleteCharacter(character.id));
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <div style={{ padding: 12, borderTop: `1px solid ${palette.divider}`, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {[{ id: 'zh-CN', key: 'settings.language.zh' }, { id: 'en', key: 'settings.language.en' }].map(option => (
            <button
              key={option.id}
              type="button"
              style={{ ...ghost, background: localeId === option.id ? palette.primary : 'transparent', color: localeId === option.id ? palette.primaryContrast : palette.textMuted }}
              onClick={() => setLocaleId(option.id)}
            >
              {t(option.key)}
            </button>
          ))}
          {themes.slice(0, 3).map(option => (
            <button
              key={option.id}
              type="button"
              style={{ ...ghost, background: themeId === option.id ? palette.primary : 'transparent', color: themeId === option.id ? palette.primaryContrast : palette.textMuted }}
              onClick={() => setThemeId(option.id)}
            >
              {option.id}
            </button>
          ))}
        </div>
      </aside>

      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <header style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 20px', borderBottom: `1px solid ${palette.divider}` }}>
          <strong style={{ fontSize: fonts.scaled(17) }}>EasyChat2 Desktop</strong>
          <span style={{ color: palette.textMuted, fontSize: fonts.scaled(12) }}>
            {loaded ? `${characters.length} / ${sessions.length}` : '…'}
          </span>
          {startupError ? <span style={{ color: palette.danger || '#ff8787', fontSize: fonts.scaled(12) }}>{String(startupError.title || 'startup error')}</span> : null}
          <span style={{ flex: 1 }} />
          {[
            { id: 'chat', label: t('app.tab.chat'), action: () => setView('chat') },
            { id: 'character', label: t('app.tab.character'), action: () => setView('character') },
            { id: 'memory', label: t('app.tab.memory'), action: () => setView('memory') },
            { id: 'extension', label: t('app.tab.extension'), action: () => setView('extension') },
            { id: 'settings', label: t('app.tab.settings'), action: () => setView('settings') },
          ].map(tab => (
            <button
              key={tab.id}
              type="button"
              style={{ ...ghost, background: view === tab.id && !showSessions && !showBackup ? palette.surfaceAlt : 'transparent' }}
              onClick={() => {
                setView(tab.id);
                setShowSessions(false);
                setShowBackup(false);
              }}
            >
              {tab.label}
            </button>
          ))}
          <button
            type="button"
            style={{ ...ghost, background: showBackup ? palette.surfaceAlt : 'transparent' }}
            onClick={() => {
              setShowBackup(value => !value);
              setShowSessions(false);
            }}
          >
            {t('backup.title')}
          </button>
          <button
            type="button"
            style={{ ...ghost, background: showSessions ? palette.surfaceAlt : 'transparent' }}
            onClick={() => {
              setShowSessions(value => !value);
              setShowBackup(false);
            }}
          >
            {t('app.tab.sessions')}
          </button>
          <button
            type="button"
            style={ghost}
            disabled={!!busy || !activeCharacter}
            onClick={() => run('session', () => ensureCharacterSession(activeId))}
          >
            +
          </button>
        </header>

        {showSessions ? (
          <SessionsPanel
            palette={palette}
            fonts={fonts}
            character={activeCharacter}
            sessions={characterSessions}
            activeSessionId={activeSessionId}
            busy={busy}
            onSwitch={id => { switchSession(id); setShowSessions(false); }}
            onDelete={id => run('deleteSession', () => deleteSession(id))}
            onPin={id => run('pinSession', () => pinSession(id)).then(() => refreshSessions().catch(() => {}))}
            onClone={id => run('cloneSession', () => cloneSession(id))}
            onRenameDone={() => refreshSessions().catch(() => {})}
          />
        ) : view === 'settings' ? (
          <SettingsScreen
            palette={palette}
            fonts={fonts}
            version={appVersion}
            onTutorial={() => setShowTutorial(true)}
            onDisclaimer={() => setShowDisclaimer(true)}
            onBackup={() => setShowBackup(true)}
          />
        ) : view === 'character' ? (
          characterScreen === 'library' ? (
            <CharacterLibraryScreen
              characters={characters}
              activeId={activeId}
              palette={palette}
              fonts={fonts}
              busy={!!busy}
              onOpen={id => {
                // 打开 = 切换角色 + 进聊天页（与侧栏点击同义）。
                switchCharacter(id);
                setView('chat');
              }}
              onCreate={() => run('add', () => addCharacter(DEFAULT_NEW_CHARACTER)).then(() => setCharacterScreen('edit'))}
              onEdit={id => {
                if (id !== activeId) switchCharacter(id);
                setCharacterScreen('edit');
              }}
              onDelete={id => run('delete', () => deleteCharacter(id))}
              onPin={(id, pinned) => run('pin', () => pinCharacter(id, pinned))}
              onImport={importCard}
            />
          ) : (
            <CharacterEditScreen
              character={activeCharacter}
              palette={palette}
              fonts={fonts}
              onBack={() => setCharacterScreen('library')}
              onSaved={next => updateCharacter(next)}
            />
          )
        ) : view === 'memory' ? (
          <MemoryScreen palette={palette} fonts={fonts} character={activeCharacter} />
        ) : view === 'extension' ? (
          <ExtensionScreen palette={palette} fonts={fonts} />
        ) : activeSessionId ? (
          <ChatPane palette={palette} fonts={fonts} />
        ) : (
          <section style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: palette.textMuted }}>
            {t('app.tab.memory')} …
          </section>
        )}
      </main>
      <AlertHost palette={palette} fonts={fonts} />
      <BackupPanel
        open={showBackup}
        onClose={() => setShowBackup(false)}
        palette={palette}
        fonts={fonts}
        app={{
          character: activeCharacter,
          addCharacter,
          ensureCharacterSession,
          updateCharacter,
          refreshAppData,
        }}
      />
      <TutorialDialog
        open={showTutorial || firstRunStage === 'onboarding'}
        onClose={() => {
          setShowTutorial(false);
          if (firstRunStage === 'onboarding') {
            completeOnboarding()
              .then(() => setFirstRunStage('done'))
              .catch(() => {});
          }
        }}
        palette={palette}
        fonts={fonts}
      />
      <DisclaimerDialog
        open={showDisclaimer || firstRunStage === 'disclaimer'}
        onClose={() => {
          setShowDisclaimer(false);
          if (firstRunStage === 'disclaimer') {
            acknowledgeDisclaimer()
              .then(() => isOnboardingDone())
              .then(done => setFirstRunStage(done ? 'done' : 'onboarding'))
              .catch(() => {
                Alert.alert(t('app.save.failed.title'), t('app.save.failed.body'));
              });
          }
        }}
        palette={palette}
        fonts={fonts}
      />
    </div>
  );
}

export default function DesktopApp() {
  return (
    <I18nProvider>
      <ThemeProvider>
        <AppProvider>
          <Shell />
        </AppProvider>
      </ThemeProvider>
    </I18nProvider>
  );
}
