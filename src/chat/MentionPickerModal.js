// 提及成员弹窗。从 src/ChatScreen.js 原样外提（无行为变化）。

import React, { useMemo } from 'react';
import { Image, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { Sheet } from '../ui/index.js';
import { useTheme } from '../theme/ThemeContext.js';
import { useTranslation } from '../i18n/I18nContext.js';
import { EVERYONE_MENTION } from './groupMentions.js';
import { createChatStyles } from './chatStyles.js';

export default function MentionPickerModal({
  visible,
  onClose,
  groupCharacters,
  insertMention,
}) {
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
  const styles = useMemo(() => createChatStyles(theme, fonts, tokens), [theme, fonts, tokens]);

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      backdropStyle={styles.modalBackdrop}
      cardStyle={[styles.modalSheet, styles.sheetWidth]}
      cardAbsorbPress
      header={<Text style={styles.modalTitle}>{t('chat.mention.title')}</Text>}
    >
      <ScrollView style={styles.modalList} keyboardShouldPersistTaps="handled">
        <TouchableOpacity
          style={styles.modalRow}
          onPress={() => {
            onClose();
            insertMention(EVERYONE_MENTION);
          }}
          activeOpacity={0.7}
        >
          <View style={styles.modalRowAvatarFallback}>
            <Ionicons name="people" size={14} color={theme.colors.accentText} />
          </View>
          <Text style={styles.modalRowText}>@{EVERYONE_MENTION}</Text>
        </TouchableOpacity>
        {groupCharacters.map(item => (
          <TouchableOpacity
            key={item.id}
            style={styles.modalRow}
            onPress={() => {
              onClose();
              insertMention(String(item.name || '').trim());
            }}
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
            <Text style={styles.modalRowText} numberOfLines={1}>
              {item.name || t('chat.mention.unnamed')}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </Sheet>
  );
}
