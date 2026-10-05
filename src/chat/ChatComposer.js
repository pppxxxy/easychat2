// 聊天页输入区（引用条 + 附件条 + 输入框 + 发送/停止）。从 src/ChatScreen.js 原样外提（无行为变化）。
// 2026-10-05 排版收敛：@ 提及按钮移除（光标落在 @ 后自动弹面板）、全屏按钮移除
// （长按输入框/「⋯」菜单触发）、三条条件条统一为 ContextBar、附件条横向滚动。

import React, { useMemo } from 'react';
import { Image, ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTranslation } from '../i18n/I18nContext.js';
import { useTheme } from '../theme/ThemeContext.js';
import ContextBar from './ContextBar.js';
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
  inputDisabled,
  onPickAttachment,
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
  const { t } = useTranslation();
  const styles = useMemo(() => createChatStyles(theme, fonts, tokens), [theme, fonts, tokens]);

  return (
    <>
      {quoteTarget ? (
        <ContextBar
          bgUri={bgUri}
          icon="chatbubble-outline"
          onAction={onCancelQuote}
          actionDisabled={quoteLocked}
          actionA11y={t('chat.composer.a11y.cancelQuote')}
        >
          <View style={styles.quoteBarBody}>
            <Text style={styles.quoteBarName} numberOfLines={1}>{quoteTarget.name || t('chat.composer.quote.fallbackName')}</Text>
            <Text style={styles.quoteBarText} numberOfLines={1}>{quoteTarget.text}</Text>
          </View>
        </ContextBar>
      ) : null}
      {attachments.length > 0 ? (
        <ContextBar bgUri={bgUri} icon="paperclip-outline">
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            {attachments.map(item => (
              <View key={item.id} style={styles.attachmentChip}>
                {item.kind === 'image' && item.uri ? (
                  <Image source={{ uri: item.uri }} style={styles.attachmentThumb} />
                ) : item.kind === 'video' ? (
                  <Ionicons name="videocam-outline" size={14} color={theme.colors.primarySoft} />
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
          </ScrollView>
        </ContextBar>
      ) : null}
      {recording ? (
        <ContextBar
          bgUri={bgUri}
          icon="mic"
          iconDanger
          onAction={onCancelVoice}
          actionA11y={t('chat.composer.a11y.cancelRecord')}
        >
          <Text style={styles.voiceRecordingText}>{t('chat.composer.recording')}</Text>
        </ContextBar>
      ) : null}
      <View style={[styles.inputBar, bgUri ? styles.inputBarOverlay : styles.inputBarSurface]}>
        <TouchableOpacity
          style={styles.attachButton}
          onPress={onPickAttachment}
          disabled={inputDisabled}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={t('chat.composer.a11y.attach')}
        >
          <Ionicons name="add-circle-outline" size={22} color={theme.colors.primarySoft} />
        </TouchableOpacity>
        {voiceEnabled && !isSending ? (
          recording ? (
            <TouchableOpacity
              style={[styles.attachButton, styles.voiceHoldButtonActive]}
              onPress={onStopVoice}
              activeOpacity={0.8}
              accessibilityRole="button"
              accessibilityLabel={t('chat.composer.a11y.stopRecord')}
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
              accessibilityLabel={t('chat.composer.a11y.record')}
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
          onLongPress={() => { if (!fullScreenDisabled) onOpenFullScreen(); }}
          placeholder={t('chat.composer.placeholder')}
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
           accessibilityLabel={t('chat.composer.a11y.sticker')}
         >
           <Ionicons name="happy-outline" size={21} color={theme.colors.primarySoft} />
         </TouchableOpacity>
        {isSending ? (
          <TouchableOpacity
            style={[styles.sendButton, styles.stopButton]}
            onPress={onStop}
            accessibilityLabel={t('chat.composer.a11y.stop')}
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
            accessibilityLabel={t('chat.composer.a11y.send')}
            activeOpacity={0.8}
          >
            <Ionicons name="arrow-up" size={20} color={theme.colors.text} />
          </TouchableOpacity>
        )}
      </View>
    </>
  );
}
