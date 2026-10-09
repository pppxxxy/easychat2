// 聊天设置弹窗。从 src/ChatScreen.js 原样外提（无行为变化）。

import React, { useMemo } from 'react';
import { Modal, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme } from '../theme/ThemeContext.js';
import { useTranslation } from '../i18n/I18nContext.js';
import { createChatStyles } from './chatStyles.js';

export default function ChatSettingsModal({
  visible,
  onClose,
  onOpenSystemSettings,
  editLabel,
  onOpenEditor,
  // D3：会话压缩（体积概览 + 进行中 + 触发回调）——数据仍由 ChatScreen 持有。
  compactInfo = null,
  compactBusy = false,
  onCompactSession,
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
      <TouchableOpacity
        style={styles.modalBackdrop}
        activeOpacity={1}
        onPress={onClose}
      >
        <View style={styles.modalSheet}>
          <Text style={styles.modalTitle}>{t('chat.settings.title')}</Text>
          <TouchableOpacity
            style={styles.linkRow}
            onPress={() => {
              onClose();
              onOpenSystemSettings();
            }}
            activeOpacity={0.7}
          >
            <View style={styles.linkLeft}>
              <Ionicons name="settings-outline" size={17} color={theme.colors.primaryMuted} />
              <Text style={styles.chatSettingsText}>{t('chat.settings.system')}</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={theme.colors.primary} />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.linkRow}
            onPress={() => {
              onClose();
              onOpenEditor();
            }}
            activeOpacity={0.7}
          >
            <View style={styles.linkLeft}>
              <Ionicons name="create-outline" size={17} color={theme.colors.primaryMuted} />
              <Text style={styles.chatSettingsText}>{editLabel}</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={theme.colors.primary} />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.linkRow}
            onPress={() => {
              if (!compactBusy && typeof onCompactSession === 'function') onCompactSession();
            }}
            activeOpacity={0.7}
          >
            <View style={styles.linkLeft}>
              <Ionicons name="archive-outline" size={17} color={theme.colors.primaryMuted} />
              <Text style={styles.chatSettingsText}>
                {compactBusy
                  ? t('chat.settings.compactBusy')
                  : t('chat.settings.compact', {
                    size: (compactInfo && compactInfo.sizeText) || '—',
                  })}
              </Text>
            </View>
            {(compactInfo && compactInfo.due) ? (
              <Ionicons name="alert-circle-outline" size={16} color={theme.colors.primary} />
            ) : null}
          </TouchableOpacity>
        </View>
      </TouchableOpacity>
    </Modal>
  );
}
