// 聊天面板（桌面）：消息流 + 附件/表情包 + 输入区 + 消息操作菜单。
//
// 从 provider/DesktopApp.jsx 外提（那里已超 800 行棘轮）：本文件只负责「聊天页」这一屏，
// 编排数据来自 useDesktopChat（复用共享层 useChatSend/useSessionMessages）。
import { useEffect, useRef, useState } from 'react';

import { buildQuotePayload } from '../../../src/chat/chatHelpers.js';
import { groupDisplayName, speakerNameOf } from '../group/groupModel.js';
import GroupSettingsPanel from '../group/GroupSettingsPanel.jsx';
import { countCompactionMessages } from '../../../src/chat/sessionCompaction.js';
import { useTranslation } from '../../../src/i18n/I18nContext.js';
import { Alert } from '../platform/alert.js';
import AttachmentChips from '../attachments/AttachmentChips.jsx';
import useDesktopAttachments from '../attachments/useDesktopAttachments.js';
import { buildBranchNav } from '../chat/branchNav.js';
import BranchSwitcher from '../chat/BranchSwitcher.jsx';
import ContextUsageBar from '../chat/ContextUsageBar.jsx';
import useDesktopBranches from '../chat/useDesktopBranches.js';
import useDesktopCompaction from '../chat/useDesktopCompaction.js';
import useDesktopContextUsage from '../chat/useDesktopContextUsage.js';
import MessageActionsMenu from '../render/MessageActionsMenu.jsx';
import MessageRow from '../render/MessageRow.jsx';
import StickerNameDialog from '../stickers/StickerNameDialog.jsx';
import StickerPanel from '../stickers/StickerPanel.jsx';
import useDesktopStickers from '../stickers/useDesktopStickers.js';
import useDesktopChat from './useDesktopChat.js';

export default function ChatPane({ palette, fonts }) {
  const { t } = useTranslation();
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
    characterId,
    activeSessionId,
    setMessages,
    isGroup,
    groupCharacters,
    groupMissingIds,
    activeSession,
  } = chat;
  const lastCountRef = useRef(0);
  const [dragOver, setDragOver] = useState(false);
  const [menu, setMenu] = useState(null);
  // 上下文占用：窗口取当前模型声明值（桌面无本地模型），只在消息条数变化时重算。
  const usage = useDesktopContextUsage({ messages, characterId });
  const [usageDismissed, setUsageDismissed] = useState(false);
  const [groupSettingsOpen, setGroupSettingsOpen] = useState(false);
  const memberNames = groupCharacters.map(character => String(character.name || '').trim()).filter(Boolean);
  const groupName = isGroup
    ? groupDisplayName(activeSession, memberNames, t('common.groupChat'), t('character.library.group.nameJoin'))
    : '';
  const compact = useDesktopCompaction({ setMessages, messagesRef: chat.messagesRef, characterId, usage });
  const branchesApi = useDesktopBranches({
    activeSessionId,
    setMessages,
    messagesRef: chat.messagesRef,
    isSending,
    ready,
    refreshToken: chat.branchesRefreshToken || 0,
  });
  // 版本切换器挂在「分叉点之后的第一条助手消息」上（与 Android MessageList 同口径）。
  const branchNav = buildBranchNav(messages, branchesApi.branchesByFork);
  // 切会话后「已忽略提示」复位：提示条是「本次进入会话内不再出现」。
  useEffect(() => {
    setUsageDismissed(false);
  }, [activeSessionId]);
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
      {isGroup ? (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '8px 20px',
          borderBottom: `1px solid ${palette.divider}`,
          flex: 'none',
          background: palette.surfaceAlt,
        }}
        >
          <strong style={{ fontSize: fonts.scaled(13) }}>{groupName}</strong>
          <span style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>
            {t('character.library.scrubber.groupMeta', { count: groupCharacters.length })}
          </span>
          {groupMissingIds.length > 0 ? (
            <span style={{ fontSize: fonts.scaled(11), color: palette.danger || '#ff5a5f' }}>
              {t('group.members.missing', { count: groupMissingIds.length })}
            </span>
          ) : null}
          <span style={{ flex: 1 }} />
          <button
            type="button"
            onClick={() => setGroupSettingsOpen(true)}
            style={{
              background: 'transparent',
              color: palette.textMuted,
              border: `1px solid ${palette.divider}`,
              borderRadius: 8,
              padding: '3px 10px',
              cursor: 'pointer',
              fontSize: fonts.scaled(11),
            }}
          >
            {t('group.settings.title')}
          </button>
        </div>
      ) : null}
      <ContextUsageBar
        usage={usage}
        dismissed={usageDismissed}
        meaningfulMessages={countCompactionMessages(messages)}
        onDismiss={() => setUsageDismissed(true)}
        onCompact={() => compact.compact()}
        compactBusy={compact.compactBusy}
        palette={palette}
        fonts={fonts}
      />
      <div
        ref={scrollRef}
        onScroll={onMessagesScroll}
        style={{ flex: 1, overflow: 'auto', padding: '16px 20px' }}
      >
        {messages.map(message => (
          <div key={message.id || `${message.role}-${message.text}`}>
            <MessageRow
              message={message}
              palette={palette}
              fonts={fonts}
              onRegenerate={regenerateMessage}
              onCommand={command => onInputChange(command)}
              onMenu={(target, anchor) => setMenu({ message: target, anchor })}
              speakerName={isGroup && !message.isUser && message.role !== 'user'
                ? speakerNameOf(message, memberNames, groupName)
                : ''}
            />
            {branchNav.get(String(message.id || '')) ? (
              <div style={{ display: 'flex', justifyContent: 'flex-start', marginTop: -8, marginBottom: 6, paddingLeft: 4 }}>
                <BranchSwitcher
                  nav={branchNav.get(String(message.id || ''))}
                  onPrev={() => {
                    const nav = branchNav.get(String(message.id || ''));
                    const target = nav && nav.branches.find(branch => branch.id === nav.prevId);
                    if (target) branchesApi.checkout(target);
                  }}
                  onNext={() => {
                    const nav = branchNav.get(String(message.id || ''));
                    const target = nav && nav.branches.find(branch => branch.id === nav.nextId);
                    if (target) branchesApi.checkout(target);
                  }}
                  disabled={isSending || branchesApi.checkingOut}
                  palette={palette}
                  fonts={fonts}
                />
              </div>
            ) : null}
          </div>
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
      {chat.quoteTarget ? (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          margin: '8px 12px 0',
          padding: '6px 10px',
          borderLeft: `3px solid ${palette.primaryMuted || palette.primary}`,
          borderRadius: '0 8px 8px 0',
          background: palette.surfaceAlt,
        }}
        >
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: fonts.scaled(11), fontWeight: 700, color: palette.textMuted }}>
              {chat.quoteTarget.name || t('chat.bubble.quoteOriginal')}
            </div>
            <div style={{
              fontSize: fonts.scaled(11),
              color: palette.textMuted,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            >
              {String(chat.quoteTarget.text || '')}
            </div>
          </div>
          <button
            type="button"
            onClick={() => chat.setQuoteTarget(null)}
            title={t('chat.attach.close')}
            style={{
              background: 'transparent',
              border: 'none',
              color: palette.textMuted,
              cursor: 'pointer',
              fontSize: 14,
              padding: '0 4px',
            }}
          >
            ×
          </button>
        </div>
      ) : null}
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
      {isGroup && activeSession ? (
        <GroupSettingsPanel
          open={groupSettingsOpen}
          onClose={() => setGroupSettingsOpen(false)}
          session={activeSession}
          members={groupCharacters}
          missingIds={groupMissingIds}
          palette={palette}
          fonts={fonts}
          onSaved={() => chat.refreshSessions().catch(() => {})}
        />
      ) : null}
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
      {menu ? (
        <MessageActionsMenu
          message={menu.message}
          anchor={menu.anchor}
          palette={palette}
          fonts={fonts}
          onClose={() => setMenu(null)}
          onQuote={target => {
            // 引用：复用共享 buildQuotePayload 的字段口径（name 取角色名或「我」）。
            const quoted = buildQuotePayload(
              target,
              target.role === 'user' ? t('chat.bubble.me') : (chat.characterName || '')
            );
            chat.setQuoteTarget(quoted);
          }}
          onRegenerate={regenerateMessage}
          onEditUserMessage={chat.editUserMessage}
          canRegenerate={!isSending}
        />
      ) : null}
    </div>
  );
}
