// 全屏输入弹窗。从 src/ChatScreen.js 原样外提（无行为变化）。
// onSend 由调用方注入（保留其内部会话竞态守卫逻辑）。

import React, { useMemo } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Text, TextInput, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme } from '../theme/ThemeContext.js';
import { createChatStyles } from './chatStyles.js';

export default function FullScreenInputModal({
  visible,
  onClose,
  text,
  onChangeText,
  onSend,
}) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createChatStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const canSend = !!text.trim();

  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        style={styles.fullScreenContainer}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.fullScreenHeader}>
          <Text style={styles.fullScreenTitle}>全屏输入</Text>
          <TouchableOpacity
            onPress={onClose}
            hitSlop={8}
            accessibilityLabel="退出全屏"
          >
            <Ionicons name="close" size={24} color={theme.colors.textMuted} />
          </TouchableOpacity>
        </View>
        <TextInput
          style={styles.fullScreenInput}
          value={text}
          onChangeText={onChangeText}
          placeholder="输入消息..."
          placeholderTextColor={theme.colors.textFaint}
          multiline
          textAlignVertical="top"
          autoFocus
        />
        <TouchableOpacity
          style={[styles.fullScreenSend, !canSend && styles.sendButtonDisabled]}
          onPress={onSend}
          disabled={!canSend}
          activeOpacity={0.8}
        >
          <Ionicons name="arrow-up" size={18} color={theme.colors.text} />
          <Text style={styles.fullScreenSendText}>发送</Text>
        </TouchableOpacity>
      </KeyboardAvoidingView>
    </Modal>
  );
}
