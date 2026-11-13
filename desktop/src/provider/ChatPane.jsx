// 聊天面板（桌面）：消息流 + 附件/表情包 + 输入区 + 消息操作菜单。
//
// 从 provider/DesktopApp.jsx 外提（那里已超 800 行棘轮）：本文件只负责「聊天页」这一屏，
// 编排数据来自 useDesktopChat（复用共享层 useChatSend/useSessionMessages）。
import { useEffect, useRef, useState } from 'react';

import { buildQuotePayload } from '../../../src/chat/chatHelpers.js';
import { Alert } from '../platform/alert.js';
import { resolveSteeringSend } from '../../../src/chat/steeringSend.js';
import { groupDisplayName, speakerNameOf } from '../group/groupModel.js';
import GroupSettingsPanel from '../group/GroupSettingsPanel.jsx';
import MentionPicker from '../group/MentionPicker.jsx';
import GroupHeaderBar from '../chat/GroupHeaderBar.jsx';
import CompactFocusDialog from '../chat/CompactFocusDialog.jsx';
import ConversationCardPanel from '../chat/ConversationCardPanel.jsx';
import SwitcherPanel from '../chat/SwitcherPanel.jsx';
import PanelShell from '../chat/PanelShell.jsx';
import ChatComposer from './ChatComposer.jsx';
import RunningNoticeBar from '../chat/RunningNoticeBar.jsx';
import MemorySummaryPanel from '../chat/MemorySummaryPanel.jsx';
import { countCompactionMessages } from '../../../src/chat/sessionCompaction.js';
import { useTranslation } from '../../../src/i18n/I18nContext.js';
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
  // 弹层开关集中成一个对象：它们同属「这一屏的浮层」，七个独立 useState 只是把组件
  // 顶部拉长，没有一个是独立语义。
  const [overlays, setOverlays] = useState({
    scrubber: false,
    compactFocus: false,
    conversationCard: false,
    switcher: false,
    stats: false,
    export: false,
    fullScreen: false,
    summary: false,
  });
  const openOverlay = (key, value = true) => setOverlays(current => ({ ...current, [key]: value }));
  const closeOverlay = key => setOverlays(current => ({ ...current, [key]: false }));
  const [moreAnchor, setMoreAnchor] = useState(null);
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
    // I1：本轮还在跑（工具循环）时按下发送 = 把这句话注入下一轮，而不是排队等。
    // 判定与提示文案全部复用共享层 resolveSteeringSend。
    const steeringDecision = resolveSteeringSend({
      inFlight: isSending,
      text,
      hasAttachments,
      steeringAvailable: !!chat.steeringAvailable,
    });
    if (steeringDecision.action === 'queued') {
      if (chat.pushSteering(steeringDecision.text)) {
        onInputChange('');
        // 清掉落盘草稿：否则重启会把已注入的那句当成未发送的草稿恢复出来。
        Promise.resolve(chat.persistDraftNow(activeSessionId, '')).catch(() => {});
      }
      return;
    }
    if (steeringDecision.action === 'blocked') {
      if (steeringDecision.reason === 'attachments') {
        Alert.alert(t('chat.send.steering.title'), t('chat.send.steering.attachments'));
      } else if (steeringDecision.reason === 'noLoop') {
        // 本轮不是工具循环：没有「下一轮」可注入，文字留在输入框里等本轮结束再发。
        chat.setSteeringNote(t('chat.send.steering.noLoop'));
      }
      return;
    }
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

  // 「更多」菜单的全部条目与可用态集中在这里：一处就能看清这一屏提供了什么。
  const moreMenuProps = {
    open: !!moreAnchor,
    anchor: moreAnchor,
    onClose: () => setMoreAnchor(null),
    onToggleSearch: () => (search.open ? search.closeSearch() : search.openSearch()),
    searchOpen: search.open,
    // 「总结」先打开面板：既能就地改设置，也能在这直接开始一次总结。
    onSummarize: () => openOverlay('summary'),
    summarizing: summary.summarizing,
    canSummarize: !!ready && !isSending,
    onOpenStats: () => openOverlay('stats'),
    onOpenExport: () => openOverlay('export'),
    canExport: messages.length > 0,
    onReselectGreeting: () => greeting.open('reselect'),
    canReselectGreeting: !!activeSessionId && !isSending,
    onOpenFullScreen: () => openOverlay('fullScreen'),
    canFullScreen: !!ready && !isGroup && !!chat.greetingReady,
    onOpenScrubber: () => openOverlay('scrubber'),
    canScrubber: scrubber.scrubberMessages.length > 0,
    onOpenSelection: selection.start,
    canSelect: !!ready && messages.length > 0,
    onOpenSwitcher: () => openOverlay('switcher'),
    onOpenConversationCard: () => openOverlay('conversationCard'),
    canConversationCard: !!ready && messages.length > 0,
    onOpenModel: modelThinking.openModelPanel,
    onOpenThinking: modelThinking.openThinkingPanel,
    canSwitchModel: !!ready && !isSending,
    isGroup,
    palette,
    fonts,
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
        <GroupHeaderBar
          groupName={groupName}
          memberCount={groupCharacters.length}
          missingCount={groupMissingIds.length}
          mentionOpen={mentionOpen}
          onToggleMention={() => setMentionOpen(value => !value)}
          onOpenSettings={() => setGroupSettingsOpen(true)}
          palette={palette}
          fonts={fonts}
        />
      ) : null}
      {/* 后台生成提示：列出**非当前会话**正在跑的运行（当前会话由输入区的停止键体现）。
          数据源是应用级登记表 sessionRuns——切走会话不会中止运行，回复会写回它自己的会话。 */}
      <RunningNoticeBar
        activeSessionId={activeSessionId}
        sessionLabelOf={run => {
          const session = (chat.sessionsRef.current || []).find(item => item.id === run.sessionId);
          if (session && session.type === 'group') {
            return groupDisplayName(
              session,
              (session.members || [])
                .map(id => (chat.characters || []).find(item => item.id === id))
                .filter(Boolean)
                .map(item => String(item.name || '').trim())
                .filter(Boolean),
              t('common.groupChat'),
              t('character.library.group.nameJoin')
            );
          }
          const owner = (chat.characters || []).find(item => item.id === String((session && session.characterId) || run.characterId || ''));
          return String((owner && owner.name) || (session && session.name) || '');
        }}
        onOpen={sessionId => {
          // 切到正在跑的那段会话：先切角色再切会话（与会话列表的打开逻辑同一顺序）。
          const session = (chat.sessionsRef.current || []).find(item => item.id === sessionId);
          if (session && session.type !== 'group' && session.characterId && session.characterId !== characterId) {
            chat.switchCharacter(session.characterId).catch(() => {});
          }
          chat.switchSession(sessionId);
        }}
        palette={palette}
        fonts={fonts}
      />
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
        onCompact={() => openOverlay('compactFocus')}
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
          // 分叉点的全部分支（按 forkMessageId 分组，共享层 branchTree 的结果）。
          forkBranches={branchesApi.branchesByFork}
          onCheckoutBranch={target => branchesApi.checkout(target)}
          onDeleteBranch={target => branchesApi.remove(target)}
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
      <ChatComposer
        input={input}
        onInputChange={onInputChange}
        submit={submit}
        chat={chat}
        attach={attach}
        stickersApi={stickersApi}
        isSending={isSending}
        ready={ready}
        composerDisabled={composerDisabled}
        canSend={canSend}
        iconButton={iconButton}
        search={search}
        messages={messages}
        onOpenMore={rect => setMoreAnchor({ x: rect.left - 150, y: rect.bottom + 6 })}
        palette={palette}
        fonts={fonts}
      />
      {isGroup ? (
        <PanelShell open={mentionOpen} onClose={() => setMentionOpen(false)} width={420}>
          <MentionPicker
            open={mentionOpen}
            members={groupCharacters}
            palette={palette}
            fonts={fonts}
            onClose={() => setMentionOpen(false)}
            onPick={name => {
              // 插入到文本末尾并补一个空格：桌面没有可靠的光标位置来源
              //（受控 textarea 的 selectionStart 在输入法组合期间不可信）。
              const current = String(input || '');
              const prefix = current && !/\s$/.test(current) ? `${current} ` : current;
              onInputChange(`${prefix}@${name} `);
              setMentionOpen(false);
            }}
          />
        </PanelShell>
      ) : null}
      {isGroup && activeSession ? (
        <GroupSettingsPanel
          open={groupSettingsOpen}
          onClose={() => setGroupSettingsOpen(false)}
          session={activeSession}
          members={groupCharacters}
          // 全部角色：成员勾选要从这里增删（members 只是已选中的那些）。
          allCharacters={chat.characters}
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
      <CompactFocusDialog
        open={overlays.compactFocus}
        busy={compact.compactBusy}
        onCancel={() => closeOverlay('compactFocus')}
        onConfirm={focus => { closeOverlay('compactFocus'); compact.compact({ focus }); }}
        palette={palette}
        fonts={fonts}
      />
      <SwitcherPanel
        open={overlays.switcher}
        onClose={() => closeOverlay('switcher')}
        characters={chat.characters}
        activeId={characterId}
        onSwitchCharacter={id => chat.switchCharacter(id)}
        groupSessions={chat.groupSessions}
        activeSessionId={activeSessionId}
        onSwitchGroup={id => { chat.switchSession(id); }}
        groupNameOf={session => groupDisplayName(
          session,
          (session.members || [])
            .map(id => (chat.characters || []).find(item => item.id === id))
            .filter(Boolean)
            .map(item => String(item.name || '').trim())
            .filter(Boolean),
          t('common.groupChat'),
          t('character.library.group.nameJoin')
        )}
        palette={palette}
        fonts={fonts}
      />
      <MemorySummaryPanel
        open={overlays.summary}
        onClose={() => closeOverlay('summary')}
        onSummarize={() => summary.summarize({})}
        summarizing={summary.summarizing}
        canSummarize={!!ready && !isSending}
        palette={palette}
        fonts={fonts}
      />
      <PanelShell
        open={overlays.conversationCard}
        onClose={() => closeOverlay('conversationCard')}
      >
        <ConversationCardPanel
          messages={messages}
          characterName={chat.characterName}
          userName={String((chat.userNameRef && chat.userNameRef.current) || '')}
          palette={palette}
          fonts={fonts}
          onGenerated={() => closeOverlay('conversationCard')}
        />
      </PanelShell>
      <ScrollScrubber
        open={overlays.scrubber}
        onClose={() => closeOverlay('scrubber')}
        count={scrubber.scrubberMessages.length}
        previews={scrubber.previews}
        onSeek={index => { scrubber.seek(index); }}
        onToStart={scrubber.toStart}
        onToEnd={scrubber.toEnd}
        palette={palette}
        fonts={fonts}
      />
      <FullScreenInput
        open={overlays.fullScreen}
        value={input}
        onChange={onInputChange}
        onSend={() => { closeOverlay('fullScreen'); submit(); }}
        onClose={() => closeOverlay('fullScreen')}
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
      <ChatMoreMenu {...moreMenuProps} />
      <SessionStatsPanel
        open={overlays.stats}
        onClose={() => closeOverlay('stats')}
        sessionId={activeSessionId || ''}
        messageCount={messages.filter(item => item && !item.transient).length}
        palette={palette}
        fonts={fonts}
      />
      <ConversationExportPanel
        open={overlays.export}
        onClose={() => closeOverlay('export')}
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
