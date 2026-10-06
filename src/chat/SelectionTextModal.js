// 选择文本弹窗。从 src/ChatScreen.js 原样外提（无行为变化）。

import React, { useMemo } from 'react';
import { Modal, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';

import { useTheme } from '../theme/ThemeContext.js';
import { useTranslation } from '../i18n/I18nContext.js';
import { createChatStyles } from './chatStyles.js';

export default function SelectionTextModal({ text, onClose }) {
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
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
          <Text style={styles.modalTitle}>{t('chat.bubble.selectText')}</Text>
          <ScrollView style={styles.selectScroll} keyboardShouldPersistTaps="handled">
            <Text selectable style={styles.selectText}>{text}</Text>
          </ScrollView>
          <View style={styles.selectActions}>
            <TouchableOpacity
              style={styles.selectButton}
              onPress={() => { Clipboard.setStringAsync(text).catch(() => {}); }}
              activeOpacity={0.8}
            >
              <Text style={styles.selectButtonText}>{t('common.copy')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.selectButton, styles.selectButtonGhost]}
              onPress={onClose}
              activeOpacity={0.8}
            >
              <Text style={styles.selectButtonText}>{t('common.close')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}
