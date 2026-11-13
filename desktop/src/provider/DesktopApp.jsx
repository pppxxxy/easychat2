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
import { Alert, resolveAlert, subscribeAlert } from '../platform/alert.js';
import AttachmentChips from '../attachments/AttachmentChips.jsx';
import useDesktopAttachments from '../attachments/useDesktopAttachments.js';
import BackupPanel from '../backup/BackupPanel.jsx';
import MessageRow from '../render/MessageRow.jsx';
import StickerNameDialog from '../stickers/StickerNameDialog.jsx';
import StickerPanel from '../stickers/StickerPanel.jsx';
import useDesktopStickers from '../stickers/useDesktopStickers.js';
import useDesktopChat from './useDesktopChat.js';

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

function ChatPane({ palette, fonts, t }) {
  const chat = useDesktopChat();
  const {
    messages,
    isSending,
    input,
    onInputChange,
    sendText,
    regenerateMessage,
    modelFallbackNotice,
    scrollRef,
    onMessagesScroll,
    autoScrollToBottom,
    ready,
    attachments,
  } = chat;
  const lastCountRef = useRef(0);
  const [dragOver, setDragOver] = useState(false);
  const attach = useDesktopAttachments({
    attachments,
    attachmentsRef: chat.attachmentsRef,
    setAttachments: chat.setAttachments,
    isSending,
    ready,
    captureSessionGuard: chat.captureSessionGuard,
    isSessionGuardCurrent: chat.isSessionGuardCurrent,
  });
  const hasAttachments = attach.attachments.length > 0;
  const stickersApi = useDesktopStickers({
    ready,
    isSending,
    captureSessionGuard: chat.captureSessionGuard,
    isSessionGuardCurrent: chat.isSessionGuardCurrent,
    sendMessage: chat.sendMessage,
    getInput: chat.getInput,
  });

  useEffect(() => {
    globalThis.__easychat2Chat = {
      ready,
      greetingReady: chat.greetingReady,
      isSending,
      input: String(input || ''),
      messages: messages.length,
      attachments: attach.attachments.length,
    };
  }, [ready, chat.greetingReady, isSending, input, messages.length, attach.attachments.length]);

  useEffect(() => {
    if (messages.length !== lastCountRef.current) {
      lastCountRef.current = messages.length;
      autoScrollToBottom();
    }
  }, [messages, autoScrollToBottom]);

  const submit = () => {
    const text = String(input || '').trim();
    globalThis.__easychat2Submit = {
      calls: ((globalThis.__easychat2Submit && globalThis.__easychat2Submit.calls) || 0) + 1,
      text,
      attachments: attach.attachments.length,
      isSending,
      ready,
      timestamp: Date.now(),
    };
    if ((!text && !hasAttachments) || isSending || !ready) return;
    // 冒烟/排查用：记录 sendText 的返回值或异常（不改变正常流程）。
    const result = sendText(text);
    const snapshotErrors = () => {
      try {
        return JSON.parse(JSON.stringify(chat.errorRawRef.current || {}));
      } catch (error) {
        return null;
      }
    };
    if (result && typeof result.then === 'function') {
      result.then(value => {
        globalThis.__easychat2Send = { ok: value !== false, value: String(value), rawErrors: snapshotErrors() };
      }).catch(error => {
        globalThis.__easychat2Send = { ok: false, error: String((error && error.message) || error), rawErrors: snapshotErrors() };
      });
    }
  };

  const composerDisabled = isSending || !ready || attach.loading;
  const canSend = !isSending && ready && (!!String(input || '').trim() || hasAttachments);
  const iconButton = {
    width: 40,
    height: 40,
    flex: 'none',
    background: 'transparent',
    color: palette.text,
    border: `1px solid ${palette.divider}`,
    borderRadius: 10,
    cursor: composerDisabled ? 'default' : 'pointer',
    fontSize: 17,
    lineHeight: 1,
  };

  return (
    <div
      style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, position: 'relative' }}
      onDragOver={event => {
        if (!event.dataTransfer) return;
        const types = Array.from(event.dataTransfer.types || []);
        if (!types.includes('Files')) return;
        event.preventDefault();
        if (!dragOver) setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={event => {
        event.preventDefault();
        setDragOver(false);
        const files = event.dataTransfer && event.dataTransfer.files;
        if (files && files.length > 0) attach.addFiles(files);
      }}
    >
      <div
        ref={scrollRef}
        onScroll={onMessagesScroll}
        style={{ flex: 1, overflow: 'auto', padding: '16px 20px' }}
      >
        {messages.map(message => (
          <MessageRow
            key={message.id || `${message.role}-${message.text}`}
            message={message}
            palette={palette}
            fonts={fonts}
            onRegenerate={regenerateMessage}
            onCommand={command => onInputChange(command)}
          />
        ))}
      </div>
      {dragOver ? (
        <div style={{
          position: 'absolute',
          inset: 10,
          zIndex: 5,
          border: `2px dashed ${palette.primary}`,
          borderRadius: 14,
          background: 'rgba(0,0,0,0.35)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          pointerEvents: 'none',
          color: palette.text,
          fontSize: fonts.scaled(15),
          fontWeight: 700,
        }}
        >
          {t('chat.attach.dropHint')}
        </div>
      ) : null}
      {modelFallbackNotice ? (
        <div style={{ padding: '4px 20px', color: palette.textMuted, fontSize: fonts.scaled(12) }}>
          {String(modelFallbackNotice.text || modelFallbackNotice.model || '')}
        </div>
      ) : null}
      <AttachmentChips
        attachments={attach.attachments}
        palette={palette}
        fonts={fonts}
        disabled={isSending}
        onRemove={attach.removeAttachment}
      />
      {stickersApi.panelOpen ? (
        <StickerPanel
          stickers={stickersApi.stickers}
          palette={palette}
          fonts={fonts}
          busy={stickersApi.busy}
          disabled={isSending || !ready}
          onSend={stickersApi.sendSticker}
          onImport={stickersApi.importSticker}
          onClose={() => stickersApi.setPanelOpen(false)}
        />
      ) : null}
      <div style={{ borderTop: `1px solid ${palette.divider}`, padding: 12, display: 'flex', gap: 10, alignItems: 'flex-end' }}>
        <button
          type="button"
          title={t('chat.attach.image.title')}
          onClick={attach.pickImages}
          disabled={composerDisabled}
          style={iconButton}
        >
          🖼
        </button>
        <button
          type="button"
          title={t('chat.attach.video.title')}
          onClick={attach.pickVideos}
          disabled={composerDisabled}
          style={iconButton}
        >
          🎬
        </button>
        <button
          type="button"
          title={t('chat.attach.text.title')}
          onClick={attach.pickText}
          disabled={composerDisabled}
          style={iconButton}
        >
          📄
        </button>
        <button
          type="button"
          title={t('chat.sticker.title')}
          onClick={stickersApi.togglePanel}
          disabled={composerDisabled}
          style={{ ...iconButton, background: stickersApi.panelOpen ? palette.surfaceAlt : 'transparent' }}
        >
          😀
        </button>
        <button
          type="button"
          title={t('chat.attach.voice.title')}
          onClick={() => Alert.alert(t('chat.attach.voice.title'), t('chat.attach.voiceUnsupported'))}
          style={iconButton}
        >
          🎤
        </button>
        <textarea
          value={input}
          onChange={event => onInputChange(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          onPaste={event => {
            const files = event.clipboardData && event.clipboardData.files;
            if (files && files.length > 0) {
              event.preventDefault();
              attach.addFiles(files);
            }
          }}
          placeholder={t('chat.composer.placeholder')}
          rows={2}
          style={{
            flex: 1,
            resize: 'none',
            background: palette.surface,
            color: palette.text,
            border: `1px solid ${palette.divider}`,
            borderRadius: 10,
            padding: '10px 12px',
            fontSize: fonts.scaled(14),
            fontFamily: 'inherit',
            outline: 'none',
          }}
        />
        <button
          type="button"
          onClick={submit}
          disabled={!canSend}
          style={{
            background: isSending ? palette.surfaceAlt : palette.primary,
            color: isSending ? palette.textMuted : palette.primaryContrast,
            border: 'none',
            borderRadius: 10,
            padding: '10px 16px',
            fontWeight: 700,
            cursor: isSending ? 'default' : 'pointer',
            fontSize: fonts.scaled(13),
          }}
        >
          {isSending ? '…' : t('chat.send.action')}
        </button>
      </div>
      <StickerNameDialog
        pending={stickersApi.pending}
        nameDraft={stickersApi.nameDraft}
        palette={palette}
        fonts={fonts}
        busy={stickersApi.busy}
        onChange={stickersApi.setNameDraft}
        onCancel={stickersApi.cancelPending}
        onSave={stickersApi.confirmSave}
      />
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
    updateCharacter,
    refreshAppData,
  } = useApp();
  const [busy, setBusy] = useState('');
  const [showSessions, setShowSessions] = useState(false);
  const [showBackup, setShowBackup] = useState(false);
  const ensuredRef = useRef(false);

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
          <button type="button" style={ghost} disabled={!!busy} onClick={() => run('add', () => addCharacter(DEFAULT_NEW_CHARACTER))}>
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
            style={{ ...ghost, background: showBackup ? palette.surfaceAlt : 'transparent' }}
            onClick={() => setShowBackup(value => !value)}
          >
            {t('backup.title')}
          </button>
          <button
            type="button"
            style={{ ...ghost, background: showSessions ? palette.surfaceAlt : 'transparent' }}
            onClick={() => setShowSessions(value => !value)}
          >
            {t('app.tab.memory')}
          </button>
          <button
            type="button"
            style={ghost}
            disabled={!!busy || !activeCharacter}
            onClick={() => run('session', () => ensureCharacterSession(activeId))}
          >
            ＋
          </button>
        </header>

        {showSessions ? (
          <section style={{ flex: 1, overflow: 'auto', padding: 20 }}>
            <div style={{ color: palette.textMuted, fontSize: fonts.scaled(12), marginBottom: 10 }}>
              {activeCharacter ? activeCharacter.name : '—'} · {t('app.tab.memory')} ({characterSessions.length})
            </div>
            {characterSessions.map(session => (
              <div
                key={session.id}
                role="button"
                tabIndex={0}
                onClick={() => { switchSession(session.id); setShowSessions(false); }}
                onKeyDown={event => { if (event.key === 'Enter') { switchSession(session.id); setShowSessions(false); } }}
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
          </section>
        ) : activeSessionId ? (
          <ChatPane palette={palette} fonts={fonts} t={t} />
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
