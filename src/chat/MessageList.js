// 从 ChatScreen.js 原样外提（无行为变化）：消息列表渲染段。
// 含空状态引导（有/无背景图两分支）与 renderedMessages 的逐条渲染
// （AnimatedEntry 入场、ErrorBubble/MessageBubble、多选 Pressable 包装）。
// 刻意不做 React.memo：errorRawRef.current 在渲染期读取，memo 会跳过其更新。
//
// 2026-10-12 虚拟化：滚动容器 ScrollView → FlatList（data = 尾部窗口 visibleMessages）。
// 原来「每条消息 onLayout 把 y 累积进 ChatScreen 的 messageOffsetsRef」在虚拟化下不成立
// ——渲染窗口外的项根本没有 onLayout，缓存里必然缺值。定位改走 FlatList 的
// scrollToIndex + onScrollToIndexFailed（算术见 messageScroll.js），入口经 ref 暴露给
// ChatScreen，由它继续承担「目标不在窗口里就扩窗重试」的策略（搜索命中/引用跳转/
// 滚动条共用同一条链路）。
// 不给 MessageBubble 硬编码 getItemLayout：消息高度可变（长文/图片/WebView 富文本），
// 写死高度会让 scrollToIndex 的落点整体错位。

import React, { useCallback, useImperativeHandle, useRef } from 'react';
import { FlatList, Pressable, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import AnimatedEntry from './AnimatedEntry.js';
import ErrorBubble from './ErrorBubble.js';
import ToolBubble from './ToolBubble.js';
import { TOOL_BUBBLE_KIND, SYSTEM_ERROR_ID, MESSAGE_LIST_INITIAL_RENDER, MESSAGE_LIST_RENDER_WINDOW } from './chatConstants.js';
import MessageBubble from './MessageBubble.js';
import { buildForkVersions } from './branchTree.js';
import { containsHtml } from './plainText.js';
import { shouldRenderRichHtml } from './richHtml.js';
import {
  canScrollToIndex,
  messageIndexById,
  MESSAGE_SCROLL_RETRY_DELAY_MS,
  MESSAGE_SCROLL_VIEW_OFFSET,
  scrollFallbackOffset,
  shouldRetryScrollToIndex,
} from './messageScroll.js';
import { useTranslation } from '../i18n/I18nContext.js';

const keyExtractor = message => String((message && message.id) || '');

const MessageList = React.forwardRef(function MessageList({
  scrollRef,
  styles,
  autoScrollToBottom,
  onMessagesScroll,
  messages,
  bgUri,
  isGroup,
  sessionOwnerMissing,
  openGreetingPicker,
  activeSessionId,
  theme,
  character,
  greetingReady,
  renderedMessages,
  characterMap,
  selectedMessageIdSet,
  messageSelectionOpen,
  windowSize,
  onExpandWindow,
  chatOptions,
  errorRawRef,
  rawTextById,
  displayName,
  groupCharacters,
  groupAvatarUri,
  userAvatar,
  onSlashCommand,
  regenerableIds,
  onRegenerateMessage,
  onEditUserMessage,
  onSelectText,
  onQuoteMessage,
  onPressQuoteBlock,
  generateInlineImage,
  broadcastMessage,
  onSaveImage,
  onSaveAsSticker,
  onDeleteImageMessage,
  searchQuery,
  searchMatches,
  focusedMessageId,
  onReselectGreeting,
  startMessageSelection,
  thinkingDisplay,
  openImageActions,
  toggleSelectedMessage,
  ready,
  isSending,
  branchesByFork,
  onCheckoutBranch,
  onDeleteBranch,
}, ref) {
  // 「删除其它版本」：把该分叉点的归档分支逐条删除（存储侧串行队列保证顺序）。
  const handleDeleteOthers = React.useCallback(branches => {
    (Array.isArray(branches) ? branches : []).forEach(branch => onDeleteBranch?.(branch));
  }, [onDeleteBranch]);
  // 窗口化：只渲染尾部 windowSize 条；被切走的更早消息通过「加载更早消息」放开。
  // 窗口（数据）与虚拟化（挂载）是两层：窗口外扩到 400 条时，真正挂载的仍只有视口附近。
  const { t } = useTranslation();
  const totalCount = renderedMessages.length;
  const visibleMessages = totalCount > windowSize
    ? renderedMessages.slice(totalCount - windowSize)
    : renderedMessages;
  const hiddenCount = totalCount - visibleMessages.length;
  const forkMap = branchesByFork instanceof Map ? branchesByFork : null;

  // 定位：index 是**当前窗口内**的下标。visibleRef 供回调读取最新数据
  // （ref 回调在异步 setTimeout 里执行，闭包里的 visibleMessages 会是旧数组）。
  const visibleRef = useRef(visibleMessages);
  visibleRef.current = visibleMessages;
  const scrollRetryRef = useRef(0);

  const scrollToMessageIndex = useCallback(index => {
    if (!canScrollToIndex(index, visibleRef.current.length)) return false;
    scrollRef.current?.scrollToIndex?.({ index, viewOffset: MESSAGE_SCROLL_VIEW_OFFSET, animated: true });
    return true;
  }, [scrollRef]);

  // ChatScreen 的 scrollToMessage 走这个句柄：返回 false 表示目标不在当前窗口里，
  // 由它扩窗（MESSAGE_WINDOW_STEP_SCROLL）后重试——与旧实现的「offsets 里没有就扩窗」等价。
  useImperativeHandle(ref, () => ({
    scrollToMessage(id) {
      scrollRetryRef.current = 0;
      return scrollToMessageIndex(messageIndexById(visibleRef.current, id));
    },
  }), [scrollToMessageIndex]);

  // 没有 getItemLayout 时，scrollToIndex 对「还没测量过的项」不猜位置，而是回调这里
  //（VirtualizedList.js:181-197）。兜底 = 先按框架给的平均项高估个落点滚过去，让目标
  // 进入已测量范围后重试；重试次数有限，否则估算偏差大时会变成滚动风暴。
  const onScrollToIndexFailed = useCallback(({ index, averageItemLength }) => {
    if (!shouldRetryScrollToIndex(scrollRetryRef.current)) return;
    scrollRetryRef.current += 1;
    if (!canScrollToIndex(index, visibleRef.current.length)) return;
    scrollRef.current?.scrollToOffset?.({ offset: scrollFallbackOffset({ index, averageItemLength }), animated: false });
    setTimeout(() => scrollToMessageIndex(index), MESSAGE_SCROLL_RETRY_DELAY_MS);
  }, [scrollRef, scrollToMessageIndex]);

  // 列表头：窗口化提示 + 从会话最前分叉的分支入口。两者都只在有消息时出现
  //（空态由 ListEmptyComponent 独占，与旧的 messages.length === 0 分支等价）。
  const listHeader = messages.length === 0 ? null : (
    <>
      {hiddenCount > 0 ? (
        <TouchableOpacity
          key="load-earlier"
          style={styles.loadEarlierButton}
          onPress={() => onExpandWindow()}
          accessibilityRole="button"
          accessibilityLabel={t('chat.list.loadEarlierA11y')}
        >
          <Text style={styles.loadEarlierText}>
            {t('chat.list.loadEarlier', { count: hiddenCount })}
          </Text>
        </TouchableOpacity>
      ) : null}
    </>
  );

  const listEmpty = messages.length === 0 ? (
    bgUri ? (
      // 有自定义/内置背景图时不再叠加「开始聊天/当前角色/请先填写 API」引导块：
      // 背景图上再压一段旧引导文案既突兀又像第二层背景。只保留「选择开场白」入口。
      !isGroup && !sessionOwnerMissing ? (
        <View style={styles.emptyState}>
          <TouchableOpacity
            style={styles.emptyGreetingButton}
            onPress={() => openGreetingPicker(activeSessionId ? 'reselect' : 'new')}
            activeOpacity={0.8}
          >
            <Text style={styles.emptyGreetingButtonText}>{t('chat.list.chooseGreeting')}</Text>
          </TouchableOpacity>
        </View>
      ) : null
    ) : (
      <View style={styles.emptyState}>
        <View style={styles.emptyIconBadge}>
          <Ionicons name="chatbubbles-outline" size={36} color={theme.colors.primaryMuted} />
        </View>
        <Text style={styles.emptyTitle}>{t('chat.list.emptyTitle')}</Text>
        <Text style={styles.emptyText}>
          {t('chat.list.currentRole', { name: sessionOwnerMissing ? t('chat.list.ownerMissing') : (character.name || t('chat.list.defaultAssistant')) })}{'\n'}
          {sessionOwnerMissing
            ? t('chat.list.hintOwnerMissing')
            : !greetingReady
              ? t('chat.list.hintChooseGreeting')
              : t('chat.list.hintApiKey')}{'\n'}
        </Text>
        {!isGroup && !sessionOwnerMissing ? (
          <TouchableOpacity
            style={styles.emptyGreetingButton}
            onPress={() => openGreetingPicker(activeSessionId ? 'reselect' : 'new')}
            activeOpacity={0.8}
          >
            <Text style={styles.emptyGreetingButtonText}>{t('chat.list.chooseGreeting')}</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    )
  ) : null;

  // renderItem 每次渲染都是新引用：VirtualizedList 的 CellRenderer 是 PureComponent，
  // 靠这个引用变化重渲染已挂载的单元格——与旧的「整段 map 重渲染」等价，不需要 extraData
  //（也就不会出现「漏了 extraData 某字段 → 单元格读到旧 props」的静默失效）。
  const renderMessage = ({ item: message, index }) => {
    const speaker = message.speakerId ? characterMap.get(message.speakerId) : null;
    const selected = selectedMessageIdSet.has(String(message.id || ''));
    const richInteractive =
      message.role !== SYSTEM_ERROR_ID
      && !message.pending
      && !message.image
      && containsHtml(message.text)
      && shouldRenderRichHtml(message.text, chatOptions.richHtml !== false);
    // 富 HTML 消息内含 WebView：外层 Pressable 会抢走手势，导致卡片内部滚不动。
    // 非多选状态下不包 Pressable，多选入口改由三点菜单的「选择消息」提供。
    const distanceFromBottom = totalCount - 1 - (hiddenCount + index);
    const shouldAnimate = distanceFromBottom < 15;
    // 这里每帧都会重算（列表一变距离就变），但 AnimatedEntry 只在**挂载时**取一次
    // delay：否则新消息到达会让旧消息的入场动画跟着重启（整屏闪一下）。
    const entryDelay = distanceFromBottom * 40;
    // 版本切换器挂在「分叉点之后的第一条消息」（= 被重新生成的那条助手回复）上：
    // 分叉点 = 前一条消息；首条可见消息的前一条被窗口切走时无法判定，跳过不显示。
    const prevId = index > 0
      ? String(visibleMessages[index - 1] && visibleMessages[index - 1].id || '')
      : (hiddenCount === 0 ? '' : null);
    const forkBranches = prevId !== null && forkMap ? (forkMap.get(prevId) || []) : [];
    const branchNav = forkBranches.length > 0
      ? {
        ...buildForkVersions(forkBranches, message.timestamp),
        branches: forkBranches,
        disabled: isSending || !ready,
      }
      : null;
    const body = (
        <AnimatedEntry delay={entryDelay} enabled={shouldAnimate}>
          {message.kind === TOOL_BUBBLE_KIND ? (
            <ToolBubble message={message} />
          ) : message.role === SYSTEM_ERROR_ID ? (
            <ErrorBubble
              message={message}
              rawError={errorRawRef.current[message.id]}
              fullWidth={chatOptions.fullWidth}
              selectionMode={messageSelectionOpen}
              selected={selected}
              branchNav={branchNav}
              onBranchCheckout={branchId => onCheckoutBranch?.(forkBranches.find(item => String(item.id) === String(branchId)) || null)}
              onBranchDeleteOthers={handleDeleteOthers}
            />
          ) : (
            <MessageBubble
              message={message}
              rawText={rawTextById.get(message.id)}
              characterName={
                isGroup
                  ? ((speaker && speaker.name) || message.speakerName || displayName)
                  : (sessionOwnerMissing ? t('chat.list.ownerMissing') : ((speaker && speaker.name) || message.speakerName || character.name))
              }
              characterAvatar={
                isGroup
                  ? (
                    (speaker && speaker.avatarUri)
                    || (message.speakerName
                      ? (groupCharacters.find(item => item.name === message.speakerName) || {}).avatarUri
                      : '')
                    || groupAvatarUri
                    || ''
                  )
                  : (speaker ? (speaker.avatarUri || '') : (message.speakerId ? '' : character.avatarUri))
              }
              userAvatarUri={userAvatar}
              onSlashCommand={onSlashCommand}
              canRegenerate={!isGroup && regenerableIds.has(message.id)}
              onRegenerate={onRegenerateMessage}
               onEditUserMessage={!isGroup ? onEditUserMessage : undefined}
              onSelectText={onSelectText}
              onQuote={onQuoteMessage}
              onPressQuote={onPressQuoteBlock}
              onGenerateImage={generateInlineImage}
              onBroadcast={broadcastMessage}
              onSaveImage={onSaveImage}
              onSaveAsSticker={onSaveAsSticker}
              onDeleteImageMessage={onDeleteImageMessage}
              highlightKeyword={searchQuery.trim()}
              isMatch={searchMatches.includes(message.id)}
              isActiveMatch={focusedMessageId === message.id}
              fullWidth={chatOptions.fullWidth}
              richHtmlEnabled={chatOptions.richHtml !== false}
              bubbleStyle={chatOptions.bubbleStyle || 'rounded'}
              onReselectGreeting={sessionOwnerMissing ? undefined : onReselectGreeting}
              onStartSelection={richInteractive ? startMessageSelection : undefined}
              thinkingDisplay={thinkingDisplay}
              overlayActions={!!bgUri}
              selectionMode={messageSelectionOpen}
              selected={selected}
              branchNav={branchNav}
              onBranchCheckout={branchId => onCheckoutBranch?.(forkBranches.find(item => String(item.id) === String(branchId)) || null)}
              onBranchDeleteOthers={handleDeleteOthers}
            />
          )}
        </AnimatedEntry>
    );
    if (richInteractive && !messageSelectionOpen) {
      return (
        <React.Fragment key={message.id}>
          <View>
            {body}
          </View>
        </React.Fragment>
      );
    }
    return (
      <React.Fragment key={message.id}>
      <Pressable
        // onLongPress 必须始终非空：长按触发进入多选后本轮会重渲染，
        // 若此时把 onLongPress 置空，松手时 RN Pressability 的
        // isPressCanceledByLongPress 判定失效（Pressability.js:751），
        // 会补发 onPress 把刚选中的消息又取消掉——表现为原地松手就退出多选、
        // 只有滑动（先转 LONG_PRESS_OUT）才留得住。这里保留 onLongPress 作为
        // 「本次手势已被长按消费」的标记；多选态下长按不做新动作。
        onLongPress={() => {
          if (messageSelectionOpen) return;
          if (message.image) openImageActions(message.image, message.id);
          else startMessageSelection(message.id);
        }}
        onPress={messageSelectionOpen ? () => toggleSelectedMessage(message.id) : undefined}
        delayLongPress={350}
        disabled={!ready || isSending || message.pending}
        // 只有多选态下这条才是「按钮」（点一下选中/取消）。非多选态它只是长按
        // 手势的载体：若继续挂 role=button，读屏会把**每一条消息**都念成按钮，
        // 正文反而被当成按钮标签。accessible={false} 让读屏按内容读，多选入口
        // 仍可从三点菜单的「选择消息」进入（见上方注释）。
        accessible={messageSelectionOpen}
        accessibilityRole={messageSelectionOpen ? 'button' : undefined}
        accessibilityLabel={messageSelectionOpen ? t('chat.list.selectMessageA11y') : undefined}
        accessibilityState={messageSelectionOpen ? { selected } : undefined}
      >
        {body}
      </Pressable>
      </React.Fragment>
    );
  };

  return (
      <FlatList
        ref={scrollRef}
        style={styles.messages}
        contentContainerStyle={styles.messagesContent}
        data={visibleMessages}
        keyExtractor={keyExtractor}
        renderItem={renderMessage}
        onContentSizeChange={autoScrollToBottom}
        onScroll={onMessagesScroll}
        scrollEventThrottle={16}
        nestedScrollEnabled
        keyboardShouldPersistTaps="handled"
        // 消息高度可变：不提供 getItemLayout，定位靠 scrollToIndex + 失败兜底。
        onScrollToIndexFailed={onScrollToIndexFailed}
        initialNumToRender={MESSAGE_LIST_INITIAL_RENDER}
        windowSize={MESSAGE_LIST_RENDER_WINDOW}
        // 富文本消息内含 WebView：保留原生视图，避免 detach/attach 期间的空白与手势异常
        //（与角色库 FlatList 同一取舍，见 CharacterLibraryScreen.js）。
        removeClippedSubviews={false}
        ListHeaderComponent={listHeader}
        ListEmptyComponent={listEmpty}
      />
  );
});

export default MessageList;
