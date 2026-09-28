// 选择文本弹窗。从 src/ChatScreen.js 原样外提（无行为变化）。

import React, { useMemo } from 'react';
import { Modal, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';

import { useTheme } from '../theme/ThemeContext';
import { createChatStyles } from './chatStyles';

export default function SelectionTextModal({ text, onClose }) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createChatStyles(theme, fonts, tokens), [theme, fonts, tokens]);

  return (
    <Modal
      visible={!!text}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <View style={styles.modalBackdrop}>
        <View style={styles.modalSheet}>
          <Text style={styles.modalTitle}>选择文本</Text>
          <ScrollView style={styles.selectScroll} keyboardShouldPersistTaps="handled">
            <Text selectable style={styles.selectText}>{text}</Text>
          </ScrollView>
          <View style={styles.selectActions}>
            <TouchableOpacity
              style={styles.selectButton}
              onPress={() => { Clipboard.setStringAsync(text).catch(() => {}); }}
              activeOpacity={0.8}
            >
              <Text style={styles.selectButtonText}>复制</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.selectButton, styles.selectButtonGhost]}
              onPress={onClose}
              activeOpacity={0.8}
            >
              <Text style={styles.selectButtonText}>关闭</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}
