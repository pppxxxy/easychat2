// 从 ChatScreen.js 原样外提（无行为变化）：消息列表渲染段。
// 含空状态引导（有/无背景图两分支）与 renderedMessages 的逐条渲染
// （AnimatedEntry 入场、ErrorBubble/MessageBubble、多选 Pressable 包装）。
// 刻意不做 React.memo：errorRawRef.current 在渲染期读取，memo 会跳过其更新。

import React from 'react';
import { Pressable, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import AnimatedEntry from './AnimatedEntry.js';
import ErrorBubble from './ErrorBubble.js';
import MessageBubble from './MessageBubble.js';
import BranchForkRow from './BranchForkRow.js';
import { SYSTEM_ERROR_ID } from './chatConstants.js';
import { containsHtml } from './plainText.js';
import { shouldRenderRichHtml } from './richHtml.js';
import { useTranslation } from '../i18n/I18nContext.js';

function MessageList({
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
  onMessageLayout,
  openImageActions,
  toggleSelectedMessage,
  ready,
  isSending,
  branchesByFork,
  onCheckoutBranch,
  onDeleteBranch,
}) {
  // 窗口化：只渲染尾部 windowSize 条；被切走的更早消息通过「加载更早消息」放开。
  const { t } = useTranslation();
  const totalCount = renderedMessages.length;
  const visibleMessages = totalCount > windowSize
    ? renderedMessages.slice(totalCount - windowSize)
    : renderedMessages;
  const hiddenCount = totalCount - visibleMessages.length;
  const forkMap = branchesByFork instanceof Map ? branchesByFork : null;
  const rootBranches = forkMap ? (forkMap.get('') || []) : [];
  return (
      <ScrollView
        ref={scrollRef}
        style={styles.messages}
        contentContainerStyle={styles.messagesContent}
        onContentSizeChange={autoScrollToBottom}
        onScroll={onMessagesScroll}
        scrollEventThrottle={16}
        nestedScrollEnabled
        keyboardShouldPersistTaps="handled"
      >
        {messages.length === 0 ? (
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
        ) : (
          [
            hiddenCount > 0 ? (
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
            ) : null,
            // 从会话最前分叉的分支：仅在完整展示到开头（未隐藏更早消息）时渲染在顶部。
            hiddenCount === 0 && rootBranches.length > 0 ? (
              <BranchForkRow
                key="branch-fork-root"
                forkMessageId=""
                branches={rootBranches}
                styles={styles}
                theme={theme}
                onCheckoutBranch={onCheckoutBranch}
                onDeleteBranch={onDeleteBranch}
                checkoutDisabled={isSending || !ready}
              />
            ) : null,
            ...visibleMessages.map((message, index) => {
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
            const entryDelay = distanceFromBottom * 40;
            // 该消息之后是否有分叉点分支入口（按消息 id 命中）。
            const forkBranches = forkMap ? (forkMap.get(String(message.id || '')) || []) : [];
            const forkRow = forkBranches.length > 0 ? (
              <BranchForkRow
                key={`branch-fork-${message.id}`}
                forkMessageId={String(message.id || '')}
                branches={forkBranches}
                styles={styles}
                theme={theme}
                onCheckoutBranch={onCheckoutBranch}
                onDeleteBranch={onDeleteBranch}
                checkoutDisabled={isSending || !ready}
              />
            ) : null;
            const body = (
                <AnimatedEntry delay={entryDelay} enabled={shouldAnimate}>
                  {message.role === SYSTEM_ERROR_ID ? (
                    <ErrorBubble
                      message={message}
                      rawError={errorRawRef.current[message.id]}
                      fullWidth={chatOptions.fullWidth}
                      selectionMode={messageSelectionOpen}
                      selected={selected}
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
                    />
                  )}
                </AnimatedEntry>
            );
            if (richInteractive && !messageSelectionOpen) {
              return (
                <React.Fragment key={message.id}>
                  <View onLayout={event => onMessageLayout(message.id, event)}>
                    {body}
                  </View>
                  {forkRow}
                </React.Fragment>
              );
            }
            return (
              <React.Fragment key={message.id}>
              <Pressable
                onLayout={event => onMessageLayout(message.id, event)}
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
                accessibilityRole="button"
                accessibilityLabel={t('chat.list.longPressSelectA11y')}
                accessibilityState={{ selected }}
              >
                {body}
              </Pressable>
              {forkRow}
              </React.Fragment>
            );
            }),
          ]
        )}
      </ScrollView>
  );
}

export default MessageList;
