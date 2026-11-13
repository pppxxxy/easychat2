// 聊天面板（桌面）：消息流 + 附件/表情包 + 输入区 + 消息操作菜单。
//
// 从 provider/DesktopApp.jsx 外提（那里已超 800 行棘轮）：本文件只负责「聊天页」这一屏，
// 编排数据来自 useDesktopChat（复用共享层 useChatSend/useSessionMessages）。
import { useEffect, useRef, useState } from 'react';

import { buildQuotePayload } from '../../../src/chat/chatHelpers.js';
import { groupDisplayName, speakerNameOf } from '../group/groupModel.js';
import GroupSettingsPanel from '../group/GroupSettingsPanel.jsx';
import MentionPicker from '../group/MentionPicker.jsx';
import { countCompactionMessages } from '../../../src/chat/sessionCompaction.js';
import { useTranslation } from '../../../src/i18n/I18nContext.js';
import { Alert } from '../platform/alert.js';
import AttachmentChips from '../attachments/AttachmentChips.jsx';
import useDesktopAttachments from '../attachments/useDesktopAttachments.js';
import { buildBranchNav } from '../chat/branchNav.js';
import ChatMoreMenu from '../chat/ChatMoreMenu.jsx';
import ChatSearchBar from '../chat/ChatSearchBar.jsx';
import ConversationExportPanel from '../chat/ConversationExportPanel.jsx';
import FullScreenInput from '../chat/FullScreenInput.jsx';
import MessageSelectionBar from '../chat/MessageSelectionBar.jsx';
import MessageList from './MessageList.jsx';
import ScrollScrubber from '../chat/ScrollScrubber.jsx';
import useDesktopScrubber from '../chat/useDesktopScrubber.js';
import useMessageSelection from '../chat/useMessageSelection.js';
import useDesktopModelThinking from '../chat/useDesktopModelThinking.js';
import { ModelPanel, ThinkingPanel } from '../chat/ModelThinkingPanels.jsx';
import ContextUsageBar from '../chat/ContextUsageBar.jsx';
import GreetingPicker from '../chat/GreetingPicker.jsx';
import SessionStatsPanel from '../chat/SessionStatsPanel.jsx';
import { consumeGreetingPicker, subscribe as subscribeGreetingRequest } from '../chat/greetingRequest.js';
import useDesktopBranches from '../chat/useDesktopBranches.js';
import useDesktopCompaction from '../chat/useDesktopCompaction.js';
import useDesktopContextUsage from '../chat/useDesktopContextUsage.js';
import useDesktopGreeting from '../chat/useDesktopGreeting.js';
import MessageActionsMenu from '../render/MessageActionsMenu.jsx';
import StickerNameDialog from '../stickers/StickerNameDialog.jsx';
import StickerPanel from '../stickers/StickerPanel.jsx';
import useDesktopStickers from '../stickers/useDesktopStickers.js';
import useDesktopChat from './useDesktopChat.js';
import useDesktopChatSearch from '../chat/useDesktopChatSearch.js';
import useDesktopMemorySummary from '../chat/useDesktopMemorySummary.js';

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
  const [mentionOpen, setMentionOpen] = useState(false);
  const memberNames = groupCharacters.map(character => String(character.name || '').trim()).filter(Boolean);
  const groupName = isGroup
    ? groupDisplayName(activeSession, memberNames, t('common.groupChat'), t('character.library.group.nameJoin'))
    : '';
  const compact = useDesktopCompaction({ setMessages, messagesRef: chat.messagesRef, characterId, usage });
  // 对话内搜索：命中与推进口径复用共享层 chatSearchMath，桌面只补滚动与高亮。
  const search = useDesktopChatSearch({ messages, scrollRef });
  // 记忆总结：共享层 useChatSend 的 maybeAutoSummarize 在桌面是 no-op，
  // 手动入口此前也没有 —— 整套记忆系统在桌面上空转。这里补上显式入口与自动触发。
  // 模型与思考：只做在线部分（桌面无本地模型）。
  const modelThinking = useDesktopModelThinking({
    isSending,
    sendLockRef: chat.sendLockRef,
  });
  // 定位条：预览缓存复用共享层 buildScrubberPreview（流式期间只重算尾部一条）。
  const scrubber = useDesktopScrubber({
    messages,
    characterName: chat.characterName,
    scrollRef,
    searchFocusedId: search.focusedId,
  });
  // 多选与批量删除：计划由 messageDeletionPlan 算（删光 ≡ 清空、连续尾段归档）。
  const selection = useMessageSelection({
    messages,
    messagesRef: chat.messagesRef,
    setMessages,
    activeSession,
    activeSessionId,
    characterId,
    charactersRef: chat.charactersRef,
    sessionsRef: chat.sessionsRef,
    updateCharacter: chat.updateCharacter,
    setGreetingReady: chat.setGreetingReady,
    refreshSessions: chat.refreshSessions,
    isSending,
    ready,
    setQuoteTarget: chat.setQuoteTarget,
    errorRawRef: chat.errorRawRef,
  });
  const summary = useDesktopMemorySummary({
    charactersRef: chat.charactersRef,
    sessionsRef: chat.sessionsRef,
    character: chat.character,
    messagesRef: chat.messagesRef,
    activeSessionId,
    updateCharacter: chat.updateCharacter,
    refreshSessions: chat.refreshSessions,
  });
  // 把自动总结接到共享层的发送链路（useChatSend 回复落盘后调 maybeAutoSummarize）。
  // 用 ref 转发而不是改 hook 的参数：实例在面板里创建，hook 不能反向依赖它。
  useEffect(() => {
    if (!chat.autoSummarizeRef) return undefined;
    chat.autoSummarizeRef.current = summary.autoSummarize;
    return () => { chat.autoSummarizeRef.current = null; };
  }, [chat.autoSummarizeRef, summary.autoSummarize]);
  const [statsOpen, setStatsOpen] = useState(false);
  const [moreAnchor, setMoreAnchor] = useState(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [fullScreenOpen, setFullScreenOpen] = useState(false);
  const [scrubberOpen, setScrubberOpen] = useState(false);
  // Ctrl/Cmd+F 打开对话内搜索（桌面用户的肌肉记忆；手机没有条件按组合键）。
  // 只在聊天页挂载期间生效，且不抢占浏览器/系统的其它快捷键。
  useEffect(() => {
    const onKeyDown = event => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      if (String(event.key || '').toLowerCase() !== 'f') return;
      if (messages.length === 0) return;
      event.preventDefault();
      if (search.open) search.closeSearch();
      else search.openSearch();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [messages.length, search]);
  // 开场白：手机版新建对话前先选开场白（选完写回角色卡并作为首条消息）。
  // 桌面缺这一步时新会话 greetingSelected=false，共享发送链路会静默拒绝发送。
  const greeting = useDesktopGreeting({
    character: chat.character,
    messagesRef: chat.messagesRef,
    activeSessionId,
    updateCharacter: chat.updateCharacter,
    setMessages,
    setGreetingReady: chat.setGreetingReady,
    refreshSessions: chat.refreshSessions,
    onCreated: created => chat.switchSession(created.id),
  });
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

  // 顶栏「+」的请求：ChatPane 是唯一持有 messagesRef/setMessages 的地方，
  // 所以选择器在这里开。请求是一次性动作，读一次即清（见 greetingRequest.js）。
  // 两条路径都要接：① 已经在本页时直接收到通知；② 请求发生在 ChatPane 未挂载期间
  // （顶栏先 setView('chat') 再发请求，而本次渲染可能还没提交），挂载时再消费一次。
  useEffect(() => {
    const openPending = () => {
      const purpose = consumeGreetingPicker();
      if (purpose) greeting.open(purpose);
    };
    openPending();
    return subscribeGreetingRequest(openPending);
  }, [greeting.open]);

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
    // 与手机 ChatScreen.onSend 同一条前置分支：单聊还没选过开场白时，发送不是静默失败，
    // 而是先让用户选开场白（共享层 useChatSend 此时会直接 return false，什么都不会发生）。
    if (!isGroup && !chat.greetingReady) {
      greeting.open(activeSessionId ? 'reselect' : 'new');
      return;
    }
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
          {/* 群聊 @ 提及：点选成员插入 @名字（手机侧是输入 @ 自动弹）。 */}
          <button
            type="button"
            onClick={() => setMentionOpen(value => !value)}
            title={t('chat.mention.title')}
            style={{
              background: mentionOpen ? palette.surface : 'transparent',
              color: palette.textMuted,
              border: `1px solid ${palette.divider}`,
              borderRadius: 8,
              padding: '3px 10px',
              cursor: 'pointer',
              fontSize: fonts.scaled(11),
            }}
          >
            @
          </button>
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
      <ChatSearchBar
        open={search.open}
        query={search.query}
        onChangeQuery={search.changeQuery}
        matchCount={search.matchCount}
        activeMatchIndex={search.activeMatchIndex}
        onPrev={search.prev}
        onNext={search.next}
        onClose={search.closeSearch}
        palette={palette}
        fonts={fonts}
      />
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
        <MessageList
          messages={messages}
          palette={palette}
          fonts={fonts}
          selecting={selection.selecting}
          selectedIds={selection.selectedIds}
          onToggleSelect={selection.toggle}
          focusedId={search.focusedId}
          speakerNameOf={speakerNameOf}
          isGroup={isGroup}
          memberNames={memberNames}
          groupName={groupName}
          onRegenerate={regenerateMessage}
          onCommand={command => onInputChange(command)}
          onMenu={(target, anchor) => setMenu({ message: target, anchor })}
          branchNav={branchNav}
          onCheckoutBranch={target => branchesApi.checkout(target)}
          branchDisabled={isSending || branchesApi.checkingOut}
        />
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
          title={t('chat.menu.search')}
          onClick={() => (search.open ? search.closeSearch() : search.openSearch())}
          disabled={!ready || messages.length === 0}
          style={{ ...iconButton, background: search.open ? palette.surfaceAlt : 'transparent' }}
        >
          🔍
        </button>
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
        {/* 「更多」：手机上这些动作都在 ⋯ 菜单里（搜索/总结/统计/导出/重选开场白）。
            放在最右而不是中间，避免把输入区挤得太窄。 */}
        <button
          type="button"
          title={t('chat.menu.more.a11y')}
          onClick={event => {
            const rect = event.currentTarget.getBoundingClientRect();
            setMoreAnchor({ x: rect.left - 150, y: rect.bottom + 6 });
          }}
          disabled={!ready}
          style={iconButton}
        >
          ⋯
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
        {/* 与手机一致：生成中「发送」变「停止」（abort 走共享层同一个 abortRef，
            已生成的部分照常落盘，未完成的一轮不会丢）。 */}
        <button
          type="button"
          onClick={isSending ? chat.stop : submit}
          disabled={!isSending && !canSend}
          title={isSending ? t('chat.composer.a11y.stop') : t('chat.send.action')}
          style={{
            background: isSending ? palette.surfaceAlt : palette.primary,
            color: isSending ? palette.text : palette.primaryContrast,
            border: isSending ? `1px solid ${palette.divider}` : 'none',
            borderRadius: 10,
            padding: '10px 16px',
            fontWeight: 700,
            cursor: !isSending && !canSend ? 'default' : 'pointer',
            fontSize: fonts.scaled(13),
            flex: 'none',
          }}
        >
          {isSending ? t('chat.composer.a11y.stop') : t('chat.send.action')}
        </button>
      </div>
      {isGroup ? (
        <MentionPicker
          open={mentionOpen}
          members={groupCharacters}
          palette={palette}
          fonts={fonts}
          onClose={() => setMentionOpen(false)}
          onPick={name => {
            // 插入到文本末尾并补一个空格：桌面没有可靠的光标位置来源
            //（textarea 是受控的，selectionStart 在输入法组合期间不可信）。
            const current = String(input || '');
            const prefix = current && !/\s$/.test(current) ? `${current} ` : current;
            onInputChange(`${prefix}@${name} `);
            setMentionOpen(false);
          }}
        />
      ) : null}
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
      <MessageSelectionBar
        selection={selection}
        isSending={isSending}
        palette={palette}
        fonts={fonts}
      />
      <ModelPanel
        open={modelThinking.modelOpen}
        onClose={() => modelThinking.setModelOpen(false)}
        apiConfigs={modelThinking.apiConfigs}
        modelSourceId={modelThinking.modelSourceId}
        setModelSourceId={modelThinking.setModelSourceId}
        onSelectModel={modelThinking.applyModelSelection}
        busy={modelThinking.busy || isSending}
        palette={palette}
        fonts={fonts}
      />
      <ThinkingPanel
        open={modelThinking.thinkingOpen}
        onClose={() => modelThinking.setThinkingOpen(false)}
        supported={modelThinking.thinkingSupported}
        thinking={modelThinking.thinking}
        levels={modelThinking.thinkingLevels}
        displays={modelThinking.thinkingDisplays}
        onApply={modelThinking.applyThinking}
        palette={palette}
        fonts={fonts}
      />
      <ScrollScrubber
        open={scrubberOpen}
        onClose={() => setScrubberOpen(false)}
        count={scrubber.scrubberMessages.length}
        previews={scrubber.previews}
        onSeek={index => { scrubber.seek(index); }}
        onToStart={scrubber.toStart}
        onToEnd={scrubber.toEnd}
        palette={palette}
        fonts={fonts}
      />
      <FullScreenInput
        open={fullScreenOpen}
        value={input}
        onChange={onInputChange}
        onSend={() => { setFullScreenOpen(false); submit(); }}
        onClose={() => setFullScreenOpen(false)}
        palette={palette}
        fonts={fonts}
        sendLabel={t('chat.fullscreen.send')}
      />
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
      <GreetingPicker
        {...greeting.pickerProps}
        palette={palette}
        fonts={fonts}
        busy={greeting.busy}
        onCancel={greeting.cancel}
        onConfirm={greeting.confirm}
      />
      <ChatMoreMenu
        open={!!moreAnchor}
        anchor={moreAnchor}
        onClose={() => setMoreAnchor(null)}
        onToggleSearch={() => (search.open ? search.closeSearch() : search.openSearch())}
        searchOpen={search.open}
        onSummarize={() => summary.summarize({})}
        summarizing={summary.summarizing}
        canSummarize={!!ready && !isSending}
        onOpenStats={() => setStatsOpen(true)}
        onOpenExport={() => setExportOpen(true)}
        canExport={messages.length > 0}
        onReselectGreeting={() => greeting.open('reselect')}
        canReselectGreeting={!!activeSessionId && !isSending}
        onOpenFullScreen={() => setFullScreenOpen(true)}
        canFullScreen={!!ready && !isGroup && !!chat.greetingReady}
        onOpenScrubber={() => setScrubberOpen(true)}
        canScrubber={scrubber.scrubberMessages.length > 0}
        onOpenSelection={selection.start}
        canSelect={!!ready && messages.length > 0}
        onOpenModel={modelThinking.openModelPanel}
        onOpenThinking={modelThinking.openThinkingPanel}
        canSwitchModel={!!ready && !isSending}
        isGroup={isGroup}
        palette={palette}
        fonts={fonts}
      />
      <SessionStatsPanel
        open={statsOpen}
        onClose={() => setStatsOpen(false)}
        sessionId={activeSessionId || ''}
        messageCount={messages.filter(item => item && !item.transient).length}
        palette={palette}
        fonts={fonts}
      />
      <ConversationExportPanel
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        messages={messages}
        title={isGroup
          ? groupName
          : String((chat.character && chat.character.name) || '')}
        characterName={String((chat.character && chat.character.name) || '')}
        userName={String((chat.userNameRef && chat.userNameRef.current) || '')}
        isGroup={isGroup}
        palette={palette}
        fonts={fonts}
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
