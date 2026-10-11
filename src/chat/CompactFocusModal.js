// P0-5 尾巴：会话压缩的「关注点」输入入口。
//
// 关注点语义与 `/compact <关注点>` 完全一致（`normalizeCompactionFocus` →
// `buildCompactionSummaryRequest` 的 system 追加段，已有行为测试钉住）；这里只补 UI：
// 提示条与聊天设置里的「压缩」原先都是一键直压，用户没法说明「这次要特别保留什么」。
// **留空 = 与一键压缩逐字节相同**（不传 focus 就不追加那段提示词），所以这个入口
// 不会改变「不想填」的用户体验，只是多了一次确认。

import React, { useMemo } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Text, TextInput, TouchableOpacity, View } from 'react-native';

import { COMPACTION_FOCUS_MAX } from './compaction.js';
import { useTheme } from '../theme/ThemeContext.js';
import { useTranslation } from '../i18n/I18nContext.js';
import { createChatStyles } from './chatStyles.js';

export default function CompactFocusModal({
  visible,
  onClose,
  focus,
  onChangeFocus,
  onConfirm,
  busy = false,
}) {
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
  const styles = useMemo(() => createChatStyles(theme, fonts, tokens), [theme, fonts, tokens]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        style={styles.modalBackdrop}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.modalSheet}>
          <Text style={styles.modalTitle}>{t('chat.compact.focus.title')}</Text>
          <Text style={styles.compactFocusHint}>{t('chat.compact.focus.hint')}</Text>
          <TextInput
            style={styles.stickerNameInput}
            value={focus}
            onChangeText={onChangeFocus}
            placeholder={t('chat.compact.focus.placeholder')}
            placeholderTextColor={theme.colors.textFaint}
            autoFocus
            multiline
            maxLength={COMPACTION_FOCUS_MAX}
            editable={!busy}
          />
          <View style={styles.stickerNameActions}>
            <TouchableOpacity
              style={[styles.selectButton, styles.selectButtonGhost]}
              onPress={onClose}
              disabled={busy}
              activeOpacity={0.8}
            >
              <Text style={styles.selectButtonText}>{t('common.cancel')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.selectButton, busy && styles.sendButtonDisabled]}
              onPress={onConfirm}
              disabled={busy}
              activeOpacity={0.8}
            >
              <Text style={styles.selectButtonText}>
                {busy ? t('chat.settings.compactBusy') : t('chat.compact.focus.confirm')}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
