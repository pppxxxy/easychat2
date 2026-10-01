// 聊天页输入区（引用条 + 附件条 + 输入框 + 发送/停止）。从 src/ChatScreen.js 原样外提（无行为变化）。

import React, { useMemo } from 'react';
import { Image, Text, TextInput, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { MENTION_PREFIX } from '../groupMentions.js';
import { useTheme } from '../theme/ThemeContext.js';
import { createChatStyles } from './chatStyles.js';

export default function ChatComposer({
  quoteTarget,
  quoteLocked,
  onCancelQuote,
  bgUri,
  attachments,
  attachLocked,
  onRemoveAttachment,
  isSending,
  isGroup,
  inputDisabled,
  onPickAttachment,
  onOpenMention,
  input,
  onChangeInput,
  inputFocused,
  onInputFocus,
  onInputBlur,
  onSelectionChange,
  onOpenSticker,
  onOpenFullScreen,
  fullScreenDisabled,
  onStop,
  onSend,
  voiceEnabled,
  recording,
  onStartVoice,
  onStopVoice,
  onCancelVoice,
}) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createChatStyles(theme, fonts, tokens), [theme, fonts, tokens]);

  return (
    <>
      {quoteTarget ? (
        <View style={[styles.quoteBar, bgUri ? styles.inputBarOverlay : styles.inputBarSurface]}>
          <View style={styles.quoteBarBody}>
            <Text style={styles.quoteBarName} numberOfLines={1}>{quoteTarget.name || '原文'}</Text>
            <Text style={styles.quoteBarText} numberOfLines={1}>{quoteTarget.text}</Text>
          </View>
           <TouchableOpacity
             onPress={onCancelQuote}
             disabled={quoteLocked}
             hitSlop={8}
             accessibilityLabel="取消引用"
           >
            <Ionicons name="close" size={16} color={theme.colors.textFaint} />
          </TouchableOpacity>
        </View>
      ) : null}
      {attachments.length > 0 ? (
        <View style={[styles.attachmentBar, bgUri ? styles.inputBarOverlay : styles.inputBarSurface]}>
          {attachments.map(item => (
            <View key={item.id} style={styles.attachmentChip}>
              {item.kind === 'image' && item.uri ? (
                <Image source={{ uri: item.uri }} style={styles.attachmentThumb} />
              ) : (
                <Ionicons name="document-text-outline" size={14} color={theme.colors.primarySoft} />
              )}
              <Text style={styles.attachmentName} numberOfLines={1}>{item.name}</Text>
               <TouchableOpacity
                 onPress={() => onRemoveAttachment(item.id)}
                 disabled={attachLocked}
                 hitSlop={6}
               >
                 <Ionicons name="close" size={14} color={theme.colors.textFaint} />
              </TouchableOpacity>
            </View>
          ))}
        </View>
      ) : null}
      {recording ? (
        <View style={[styles.voiceRecordingBar, bgUri ? styles.inputBarOverlay : styles.inputBarSurface]}>
          <Ionicons name="mic" size={16} color={theme.colors.danger} />
          <Text style={styles.voiceRecordingText}>正在录音…松开结束，上滑取消</Text>
          <TouchableOpacity onPress={onCancelVoice} hitSlop={8} accessibilityLabel="取消录音">
            <Text style={styles.voiceCancelText}>取消</Text>
          </TouchableOpacity>
        </View>
      ) : null}
      <View style={[styles.inputBar, bgUri ? styles.inputBarOverlay : styles.inputBarSurface]}>
        {isGroup ? (
          <>
            <TouchableOpacity
              style={styles.attachButton}
              onPress={onPickAttachment}
              disabled={inputDisabled}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="添加附件"
            >
              <Ionicons name="add-circle-outline" size={22} color={theme.colors.primarySoft} />
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.attachButton}
              onPress={onOpenMention}
              disabled={inputDisabled}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="提及成员"
            >
              <Text style={styles.mentionButtonText}>{MENTION_PREFIX}</Text>
            </TouchableOpacity>
          </>
        ) : (
          <TouchableOpacity
            style={styles.attachButton}
            onPress={onPickAttachment}
            disabled={inputDisabled}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="添加附件"
          >
            <Ionicons name="add-circle-outline" size={22} color={theme.colors.primarySoft} />
          </TouchableOpacity>
        )}
        {voiceEnabled && !isSending ? (
          recording ? (
            <TouchableOpacity
              style={[styles.attachButton, styles.voiceHoldButtonActive]}
              onPress={onStopVoice}
              activeOpacity={0.8}
              accessibilityRole="button"
              accessibilityLabel="结束录音并转写"
            >
              <Ionicons name="mic" size={22} color={theme.colors.danger} />
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={styles.attachButton}
              onPress={onStartVoice}
              disabled={inputDisabled}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="录制语音消息"
            >
              <Ionicons name="mic-outline" size={22} color={theme.colors.primarySoft} />
            </TouchableOpacity>
          )
        ) : null}
        <TextInput
          style={[styles.input, bgUri && styles.inputOverlay, inputFocused && styles.inputFocused]}
          value={input}
          onChangeText={onChangeInput}
          onFocus={onInputFocus}
          onBlur={onInputBlur}
          onSelectionChange={onSelectionChange}
          placeholder="输入消息..."
           placeholderTextColor={theme.colors.textFaint}
           multiline
           editable={!inputDisabled}
         />
         <TouchableOpacity
           style={styles.stickerButton}
           onPress={onOpenSticker}
           disabled={inputDisabled}
           activeOpacity={0.7}
           accessibilityRole="button"
           accessibilityLabel="表情包"
         >
           <Ionicons name="happy-outline" size={21} color={theme.colors.primarySoft} />
         </TouchableOpacity>
         <TouchableOpacity
           style={styles.fullScreenButton}
          onPress={onOpenFullScreen}
          disabled={fullScreenDisabled}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="全屏输入"
        >
          <Ionicons name="expand-outline" size={18} color={theme.colors.primarySoft} />
        </TouchableOpacity>
        {isSending ? (
          <TouchableOpacity
            style={[styles.sendButton, styles.stopButton]}
            onPress={onStop}
            accessibilityLabel="停止"
            activeOpacity={0.8}
          >
            <Ionicons name="stop" size={18} color={theme.colors.text} />
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={[
              styles.sendButton,
              (inputDisabled || (!input.trim() && attachments.length === 0)) && styles.sendButtonDisabled,
            ]}
            onPress={onSend}
            disabled={inputDisabled || (!input.trim() && attachments.length === 0)}
            accessibilityLabel="发送"
            activeOpacity={0.8}
          >
            <Ionicons name="arrow-up" size={20} color={theme.colors.text} />
          </TouchableOpacity>
        )}
      </View>
    </>
  );
}
