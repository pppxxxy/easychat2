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
import { createGroupSession } from '../../../src/storage/sessionList.js';
import { requestGreetingPicker } from '../chat/greetingRequest.js';
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
import { decodeCardShareCode } from '../../../src/share/cardShare.js';
import CharacterEditScreen from '../character/CharacterEditScreen.jsx';
import CharacterLibraryScreen from '../character/CharacterLibraryScreen.jsx';
import ExtensionScreen from '../extension/ExtensionScreen.jsx';
import { resolveExtensionRoute } from '../extension/extensionRoutes.js';
import RoleLockGate from '../settings/RoleLockGate.jsx';
import MemoryListScreen from '../memory/MemoryListScreen.jsx';
import GroupCreatePanel from '../group/GroupCreatePanel.jsx';
import useDesktopBackgroundTasks from './useDesktopBackgroundTasks.js';
import useDesktopCharacterDelete from '../character/useDesktopCharacterDelete.js';
import DisclaimerDialog from '../settings/DisclaimerDialog.jsx';
import SettingsScreen from '../settings/SettingsScreen.jsx';
import AnnouncementDialog, { useCachedAnnouncement, useStartupAnnouncement } from '../settings/AnnouncementDialog.jsx';
import TutorialDialog from '../settings/TutorialDialog.jsx';
import ChatPane from './ChatPane.jsx';

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
  const { theme, fonts, tokens, themeId, setThemeId, themes } = useTheme();
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
    deleteCharacters,
    ensureCharacterSession,
    switchSession,
    refreshSessions,
    updateCharacter,
    pinCharacter,
    refreshAppData,
  } = useApp();
  const [busy, setBusy] = useState('');
  const [showBackup, setShowBackup] = useState(false);
  // 应用内公告：启动静默拉一次（命中才弹）+ 设置页入口只读缓存。
  // 手机侧同一份逻辑（announcements/useAnnouncement.js），这里复用共享 resolve。
  const [showAnnouncement, setShowAnnouncement] = useState(false);
  const cachedAnnouncement = useCachedAnnouncement();
  const startupAnnouncement = useStartupAnnouncement({ localVersion: appVersion });
  const announcementRelease = startupAnnouncement.release || cachedAnnouncement;
  const [view, setView] = useState('chat');
  // 角色库页（卡片网格）与角色编辑页分开：库页是「选谁」，编辑页是「改什么」。
  const [characterScreen, setCharacterScreen] = useState('library');
  // 创建群聊：与手机一致从角色库/记忆侧发起，成功后直接进聊天页。
  const [groupCreateOpen, setGroupCreateOpen] = useState(false);
  // 扩展页的二级路由（手机侧是 native-stack，桌面用 id → 组件表，见 extension/extensionRoutes.js）。
  const [extensionScreenId, setExtensionScreenId] = useState('');
  const [showTutorial, setShowTutorial] = useState(false);
  const [showDisclaimer, setShowDisclaimer] = useState(false);
  const [firstRunStage, setFirstRunStage] = useState('loading');
  const [appVersion, setAppVersion] = useState('');

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

  // 应用级到点任务（主动消息 + 自动备份）：挂在根上，与手机一样「不看用户在哪一页」。
  // 此前主动消息的调度写在扩展页里，关掉那个页面就不再触发——那是真实的功能差距。
  const charactersRef = useRef(characters);
  charactersRef.current = characters;
  useDesktopBackgroundTasks({
    ready: loaded && firstRunStage === 'done',
    charactersRef,
    appVersion,
  });

  // 角色删除：必须连带处理它的会话/动态/向量记忆（手机 runCharacterDelete 同一编排）。
  // 此前桌面只删角色表那一行，留下的会话与动态成了孤儿数据。
  const characterDelete = useDesktopCharacterDelete({
    deleteCharacter,
    deleteCharacters,
    refreshSessions,
  });

  // 每个角色第一次成为当前角色时补一个开场白会话。
  // 注意不能只做一次（原 ensuredRef 是一次性锁）：新建角色或在库里切换到一个还没有会话的
  // 角色后，聊天页会一直停在空态——用户只能靠顶栏「+」自救。这里按角色 id 记账。
  const ensuredCharacterRef = useRef('');
  useEffect(() => {
    if (!loaded || !activeCharacter || !activeId) return;
    if (ensuredCharacterRef.current === activeId) return;
    if (sessions.some(session => session.characterId === activeId)) {
      ensuredCharacterRef.current = activeId;
      return;
    }
    ensuredCharacterRef.current = activeId;
    ensureCharacterSession(activeId).catch(() => {
      // 建会话失败就允许下次重试（否则这个角色永远没有会话）。
      ensuredCharacterRef.current = '';
    });
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

  const createGroup = async ({ members, name, avatarUri, bgUri }) => {
    if (busy) return null;
    setBusy('group');
    try {
      const created = await createGroupSession(members, name, { avatarUri, bgUri });
      await refreshSessions().catch(() => {});
      setGroupCreateOpen(false);
      if (created && created.id) {
        await switchSession(created.id).catch(() => {});
        setView('chat');
      }
      return created;
    } catch (error) {
      Alert.alert(
        t('character.library.group.createFail.title'),
        String((error && error.message) || t('common.error.storageOrPermission'))
      );
      return null;
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
                setShowBackup(false);
              }}
            >
              ☰
            </button>
            <button
              type="button"
              style={ghost}
              disabled={!!busy}
              title={t('character.library.new')}
              onClick={() => {
                // 新建后直接进编辑页（新角色已由 addCharacter 设为当前角色）。
                run('add', () => addCharacter(DEFAULT_NEW_CHARACTER))
                  .then(() => {
                    setCharacterScreen('edit');
                    setView('character');
                        setShowBackup(false);
                  });
              }}
            >
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
                  run('delete', () => characterDelete.runDelete([character.id], { deleteMemories: false }));
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
              style={{ ...ghost, background: view === tab.id && !showBackup ? palette.surfaceAlt : 'transparent' }}
              onClick={() => {
                setView(tab.id);
                setShowBackup(false);
                // 切走扩展页时回到扩展首页（手机上 Stack 也是这个行为）。
                setExtensionScreenId('');
              }}
            >
              {tab.label}
            </button>
          ))}
          {/* 新建会话：与手机「聊天页 ⋯ → 新对话」同语义——**真的新建**一段，
              旧对话保留在「记忆」里。此前这里调 ensureCharacterSession，它遇到已有会话
              就只返回旧会话，按了等于没反应（手机版没有这个问题，故照它修）。
              现在改走「先选开场白、再建会话」：不带开场白建出来的会话
              greetingSelected=false，共享发送链路会**静默拒绝发送**（这是手机版
              靠开场白选择器规避的坑，桌面此前踩在上面）。 */}
          <button
            type="button"
            style={ghost}
            title={t('chat.session.newChat.title')}
            disabled={!!busy || !activeCharacter}
            onClick={() => {
              Alert.alert(
                t('chat.session.newChat.title'),
                t('chat.session.newChat.bodySingle'),
                [
                  { text: t('common.cancel'), style: 'cancel' },
                  {
                    text: t('chat.session.newChat.confirm'),
                    onPress: () => {
                      // 选择器挂在 ChatPane 里（它持有 messagesRef / setMessages），
                      // 顶栏只发一次请求，由 ChatPane 消费。
                      setView('chat');
                      requestGreetingPicker();
                    },
                  },
                ]
              );
            }}
          >
            +
          </button>
        </header>

        {view === 'settings' ? (
          <SettingsScreen
            palette={palette}
            fonts={fonts}
            version={appVersion}
            character={activeCharacter}
            onTutorial={() => setShowTutorial(true)}
            onDisclaimer={() => setShowDisclaimer(true)}
            onBackup={() => setShowBackup(true)}
            onAnnouncement={() => setShowAnnouncement(true)}
            hasAnnouncement={!!cachedAnnouncement}
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
              onCollectDeleteImpact={ids => characterDelete.collectDeleteImpact(ids)}
              onDelete={(id, options = {}) => run(
                'delete',
                () => characterDelete.runDelete([id], { deleteMemories: options.deleteMemories === true })
              )}
              onPin={(id, pinned) => run('pin', () => pinCharacter(id, pinned))}
              onImport={importCard}
              onImportShareCode={async text => {
                // 分享码 → 卡片 JSON → 走与「导入角色卡」同一条落库链路。
                const json = decodeCardShareCode(text);
                const fields = JSON.parse(json);
                const applied = await applyCharacterCard(
                  { patch: fields, fields, isPng: false },
                  { addCharacter, ensureCharacterSession, updateCharacter }
                );
                Alert.alert(
                  t('character.detail.importOk.title'),
                  t('backup.card.importDone', {
                    name: (applied.created && applied.created.name) || fields.name || '',
                  })
                );
                setCharacterScreen('library');
              }}
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
          <MemoryListScreen
            palette={palette}
            fonts={fonts}
            onOpenSession={session => {
              // 与手机一致：切换角色 + 会话后再进聊天页。
              if (session.type !== 'group' && session.characterId && session.characterId !== activeId) {
                switchCharacter(session.characterId).catch(() => {});
              }
              switchSession(session.id);
              setView('chat');
            }}
            onTutorial={() => setShowTutorial(true)}
            onCreateGroup={() => setGroupCreateOpen(true)}
          />
        ) : view === 'extension' ? (
          extensionScreenId ? (
            (() => {
              const RouteScreen = resolveExtensionRoute(extensionScreenId);
              if (!RouteScreen) return null;
              return (
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                  {/* 返回栏：手机侧由 native-stack 自带，桌面这里显式给一个。 */}
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '8px 16px',
                    borderBottom: `1px solid ${palette.divider}`,
                    flex: 'none',
                  }}
                  >
                    <button
                      type="button"
                      onClick={() => setExtensionScreenId('')}
                      style={{
                        background: 'transparent',
                        color: palette.textMuted,
                        border: `1px solid ${palette.divider}`,
                        borderRadius: 8,
                        padding: '4px 10px',
                        cursor: 'pointer',
                        fontSize: fonts.scaled(12),
                      }}
                    >
                      {t('common.back')}
                    </button>
                    <strong style={{ fontSize: fonts.scaled(14) }}>
                      {t(`ext.home.${extensionScreenId === 'image' ? 'image' : extensionScreenId}`)}
                    </strong>
                  </div>
                  <RouteScreen
                    palette={palette}
                    fonts={fonts}
                    onOpenChat={() => {
                      // 子页面里要「跳到某条对话」时用（如日记的来源会话）：
                      // 关掉二级路由并切回聊天视图——手机侧是 navigate(ROUTE_NAMES.chat)。
                      setExtensionScreenId('');
                      setView('chat');
                    }}
                  />
                </div>
              );
            })()
          ) : (
            <ExtensionScreen palette={palette} fonts={fonts} onOpen={setExtensionScreenId} />
          )
        ) : activeSessionId ? (
          // 单角色锁：上锁的角色要先输入密码才渲染聊天面板。
          // 闸门放在 ChatPane 之前而不是包住整个 App——手机上它也只在聊天路由判定。
          <RoleLockGate
            characterId={activeCharacter ? activeCharacter.id : ''}
            characterName={activeCharacter ? activeCharacter.name : ''}
            palette={palette}
            fonts={fonts}
          >
            <ChatPane
              palette={palette}
              fonts={fonts}
              tokens={tokens}
              onEditCharacter={() => {
                // 「编辑角色」提为聊天页菜单的一等公民（手机 chat.menu 同款）：
                // 从聊天直接进编辑页，不必先绕到角色库再点编辑。
                setCharacterScreen('edit');
                setView('character');
              }}
            />
          </RoleLockGate>
        ) : (
          <section style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: palette.textMuted }}>
            {t('chat.list.emptyTitle')} …
          </section>
        )}
      </main>
      <GroupCreatePanel
        open={groupCreateOpen}
        onClose={() => setGroupCreateOpen(false)}
        characters={characters}
        palette={palette}
        fonts={fonts}
        busy={busy === 'group'}
        onCreate={createGroup}
      />
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
      {/* 应用内公告：启动命中（新版本且未忽略）时自动打开；设置页「更新说明」也复用同一个弹窗。 */}
      <AnnouncementDialog
        open={showAnnouncement || startupAnnouncement.visible}
        release={announcementRelease}
        onClose={() => {
          setShowAnnouncement(false);
          startupAnnouncement.close();
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
