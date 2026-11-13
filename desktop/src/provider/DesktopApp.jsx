// S2：桌面 Provider 与「角色/会话能读能写」的最小界面。
//
// 三个 Provider 全部**逐字复用** src/ 的实现（单一事实源）：
// - I18nProvider / ThemeProvider / AppProvider 只依赖 storage 与 i18n 纯逻辑，
//   平台差异由 vite 别名 + 适配层吸收（见 vite.config.mjs）。
// AppProvider 的素材落盘入口由 main.jsx 在渲染前注入（desktop/src/platform/artwork.js）。
import { useEffect, useMemo, useRef, useState } from 'react';

import { AppProvider, useApp } from '../../../src/context/AppContext.js';
import { I18nProvider, useTranslation } from '../../../src/i18n/I18nContext.js';
import { ThemeProvider, useTheme } from '../../../src/theme/ThemeContext.js';
import { mediaUrl } from '../platform/mediaUrl.js';

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
  } = useApp();
  const [busy, setBusy] = useState('');
  const ensuredRef = useRef(false);

  const activeCharacter = characters.find(character => character.id === activeId) || null;
  const characterSessions = useMemo(
    () => sessions.filter(session => session.characterId === activeId),
    [sessions, activeId]
  );

  // 启动后为当前角色确保一段会话（与 Android 首次进聊天页的行为一致）。
  useEffect(() => {
    if (!loaded || ensuredRef.current || !activeCharacter) return;
    ensuredRef.current = true;
    if (!sessions.some(session => session.characterId === activeId)) {
      ensureCharacterSession(activeId).catch(() => {});
    }
  }, [loaded, activeCharacter, sessions, activeId, ensureCharacterSession]);

  // 诊断钩子：冒烟探针用它断言「Provider 已加载 + 角色/会话数量」。
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
    } catch (error) {
      // S2 骨架直接暴露错误，正式界面在 S3 接入应用内 Alert。
      window.alert(String((error && error.message) || error));
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
    width: 300,
    flex: 'none',
    borderRight: `1px solid ${palette.divider}`,
    display: 'flex',
    flexDirection: 'column',
    background: palette.surface,
  };
  const row = { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderRadius: 10 };
  const button = {
    background: palette.primary,
    color: palette.primaryContrast,
    border: 'none',
    borderRadius: 8,
    padding: '8px 12px',
    fontWeight: 700,
    cursor: 'pointer',
    fontSize: fonts.scaled(13),
  };
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
          <button
            type="button"
            style={ghost}
            title={t('common.confirm')}
            disabled={!!busy}
            onClick={() => run('add', () => addCharacter(DEFAULT_NEW_CHARACTER))}
          >
            ＋
          </button>
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
                title={t('common.confirm')}
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
          <button
            type="button"
            style={button}
            disabled={!!busy || !activeCharacter}
            onClick={() => run('session', () => ensureCharacterSession(activeId))}
          >
            ＋ {t('app.tab.memory')}
          </button>
        </header>

        <section style={{ flex: 1, overflow: 'auto', padding: 20 }}>
          <div style={{ color: palette.textMuted, fontSize: fonts.scaled(12), marginBottom: 10 }}>
            {activeCharacter ? activeCharacter.name : '—'} · {t('app.tab.memory')} ({characterSessions.length})
          </div>
          {characterSessions.map(session => (
            <div
              key={session.id}
              role="button"
              tabIndex={0}
              onClick={() => switchSession(session.id)}
              onKeyDown={event => { if (event.key === 'Enter') switchSession(session.id); }}
              style={{
                ...row,
                cursor: 'pointer',
                background: session.id === activeSessionId ? palette.surfaceAlt : palette.surface,
                border: `1px solid ${session.id === activeSessionId ? palette.primaryMuted : palette.divider}`,
                marginBottom: 6,
                justifyContent: 'space-between',
              }}
            >
              <span style={{ fontSize: fonts.scaled(13) }}>{session.title || session.id.slice(0, 12)}</span>
              <button
                type="button"
                style={{ ...ghost, padding: '2px 8px' }}
                disabled={!!busy}
                onClick={event => {
                  event.stopPropagation();
                  run('deleteSession', () => deleteSession(session.id));
                }}
              >
                ×
              </button>
            </div>
          ))}
          {characterSessions.length === 0 ? (
            <div style={{ color: palette.textFaint || palette.textMuted, fontSize: fonts.scaled(12) }}>
              {t('app.tab.memory')} … {loaded ? '' : '…'}
            </div>
          ) : null}
        </section>
      </main>
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
