// 保存表情包命名弹窗。从 src/ChatScreen.js 原样外提（无行为变化）。

import React, { useMemo } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Text, TextInput, TouchableOpacity, View } from 'react-native';

import { useTheme } from '../theme/ThemeContext.js';
import { createChatStyles } from './chatStyles.js';

export default function StickerNamePromptModal({
  visible,
  onClose,
  draft,
  onChangeDraft,
  confirmStickerName,
  stickerSaving,
}) {
  const { theme, fonts, tokens } = useTheme();
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
          <Text style={styles.modalTitle}>保存为表情包</Text>
          <TextInput
            style={styles.stickerNameInput}
            value={draft}
            onChangeText={onChangeDraft}
            placeholder="请输入表情包名称"
            placeholderTextColor={theme.colors.textFaint}
            autoFocus
            maxLength={40}
            editable={!stickerSaving}
          />
          <View style={styles.stickerNameActions}>
            <TouchableOpacity
              style={[styles.selectButton, styles.selectButtonGhost]}
               onPress={onClose}
              disabled={stickerSaving}
              activeOpacity={0.8}
            >
              <Text style={styles.selectButtonText}>取消</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.selectButton, stickerSaving && styles.sendButtonDisabled]}
              onPress={confirmStickerName}
              disabled={stickerSaving}
              activeOpacity={0.8}
            >
              <Text style={styles.selectButtonText}>{stickerSaving ? '保存中' : '保存'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
