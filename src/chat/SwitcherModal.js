// 角色/群聊切换弹窗。从 src/ChatScreen.js 原样外提（无行为变化）。

import React, { useMemo } from 'react';
import { Image, Modal, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme } from '../theme/ThemeContext.js';
import { useTranslation } from '../i18n/I18nContext.js';
import { createChatStyles } from './chatStyles.js';

export default function SwitcherModal({
  visible,
  onClose,
  characters,
  isGroup,
  activeId,
  onSwitch,
  groupSessions,
  activeSessionId,
  onSwitchGroup,
  groupSessionName,
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
        <TouchableOpacity style={styles.modalSheet} activeOpacity={1} onPress={() => {}}>
          <Text style={styles.modalTitle}>{t('chat.switcher.title')}</Text>
          <ScrollView style={styles.modalList} keyboardShouldPersistTaps="handled">
            {characters.map(item => {
              const selected = !isGroup && item.id === activeId;
              return (
                <TouchableOpacity
                  key={item.id}
                  style={[styles.modalRow, selected && styles.modalRowActive]}
                  onPress={() => onSwitch(item.id)}
                  activeOpacity={0.7}
                >
                  {item.avatarUri ? (
                    <Image source={{ uri: item.avatarUri }} style={styles.modalRowAvatar} />
                  ) : (
                    <View style={styles.modalRowAvatarFallback}>
                      <Text style={styles.modalRowAvatarText}>
                        {(item.name || '?').charAt(0)}
                      </Text>
                    </View>
                  )}
                  <Text
                    style={[styles.modalRowText, selected && styles.modalRowTextActive]}
                    numberOfLines={1}
                  >
                    {item.name || '未命名角色'}
                  </Text>
                  {selected ? (
                    <View style={styles.modalBadge}>
                      <Ionicons name="checkmark" size={12} color={theme.colors.text} />
                      <Text style={styles.modalBadgeText}>{t('chat.switcher.current')}</Text>
                    </View>
                  ) : null}
                </TouchableOpacity>
              );
            })}
            {groupSessions.map(item => {
              const selected = item.id === activeSessionId;
              return (
                <TouchableOpacity
                  key={`group-${item.id}`}
                  style={[styles.modalRow, selected && styles.modalRowActive]}
                  onPress={() => onSwitchGroup(item.id)}
                  activeOpacity={0.7}
                >
                  {item.avatarUri ? (
                    <Image source={{ uri: item.avatarUri }} style={styles.modalRowAvatar} />
                  ) : (
                    <View style={[styles.modalRowAvatarFallback, styles.modalRowGroupFallback]}>
                      <Ionicons name="people" size={14} color={theme.colors.primarySoft} />
                    </View>
                  )}
                  <Text
                    style={[styles.modalRowText, selected && styles.modalRowTextActive]}
                    numberOfLines={1}
                  >
                    {groupSessionName(item)}
                  </Text>
                  {selected ? (
                    <View style={styles.modalBadge}>
                      <Ionicons name="checkmark" size={12} color={theme.colors.text} />
                      <Text style={styles.modalBadgeText}>{t('chat.switcher.current')}</Text>
                    </View>
                  ) : null}
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}
