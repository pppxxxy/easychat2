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
import { SYSTEM_ERROR_ID } from './chatConstants.js';
import { containsHtml } from '../plainText.js';
import { shouldRenderRichHtml } from '../richHtml.js';

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
}) {
  // 窗口化：只渲染尾部 windowSize 条；被切走的更早消息通过「加载更早消息」放开。
  const totalCount = renderedMessages.length;
  const visibleMessages = totalCount > windowSize
    ? renderedMessages.slice(totalCount - windowSize)
    : renderedMessages;
  const hiddenCount = totalCount - visibleMessages.length;
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
                  <Text style={styles.emptyGreetingButtonText}>选择开场白</Text>
                </TouchableOpacity>
              </View>
            ) : null
          ) : (
            <View style={styles.emptyState}>
              <View style={styles.emptyIconBadge}>
                <Ionicons name="chatbubbles-outline" size={36} color={theme.colors.primaryMuted} />
              </View>
              <Text style={styles.emptyTitle}>开始聊天</Text>
              <Text style={styles.emptyText}>
                当前角色：{sessionOwnerMissing ? '角色资料缺失' : (character.name || 'EasyChat2 助手')}{'\n'}
                {sessionOwnerMissing
                  ? '这段历史对话仍可查看，角色资料恢复后才能发送。'
                  : !greetingReady
                    ? '先选择开场白，再开始发送消息。'
                    : '请先在“设置”里填写 API Key，然后输入消息。'}{'\n'}
              </Text>
              {!isGroup && !sessionOwnerMissing ? (
                <TouchableOpacity
                  style={styles.emptyGreetingButton}
                  onPress={() => openGreetingPicker(activeSessionId ? 'reselect' : 'new')}
                  activeOpacity={0.8}
                >
                  <Text style={styles.emptyGreetingButtonText}>选择开场白</Text>
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
                accessibilityLabel="加载更早消息"
              >
                <Text style={styles.loadEarlierText}>
                  加载更早消息（还有 {hiddenCount} 条）
                </Text>
              </TouchableOpacity>
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
                          : (sessionOwnerMissing ? '角色资料缺失' : ((speaker && speaker.name) || message.speakerName || character.name))
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
                      highlightKeyword={searchQuery.trim()}
                      isMatch={searchMatches.includes(message.id)}
                      isActiveMatch={focusedMessageId === message.id}
                      fullWidth={chatOptions.fullWidth}
                      richHtmlEnabled={chatOptions.richHtml !== false}
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
                <View key={message.id} onLayout={event => onMessageLayout(message.id, event)}>
                  {body}
                </View>
              );
            }
            return (
              <Pressable
                key={message.id}
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
                accessibilityLabel="长按选择消息"
                accessibilityState={{ selected }}
              >
                {body}
              </Pressable>
            );
            }),
          ]
        )}
      </ScrollView>
  );
}

export default MessageList;
