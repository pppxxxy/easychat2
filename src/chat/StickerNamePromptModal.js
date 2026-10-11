// 保存表情包命名弹窗。从 src/ChatScreen.js 原样外提（无行为变化）。

import React, { useMemo } from 'react';
import { Text, TextInput, TouchableOpacity, View } from 'react-native';

import { Sheet } from '../ui/index.js';
import { useTheme } from '../theme/ThemeContext.js';
import { useTranslation } from '../i18n/I18nContext.js';
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
  const { t } = useTranslation();
  const styles = useMemo(() => createChatStyles(theme, fonts, tokens), [theme, fonts, tokens]);

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      backdropMode="keyboard"
      backdropStyle={styles.modalBackdrop}
      cardStyle={[styles.modalSheet, styles.sheetWidth]}
      header={<Text style={styles.modalTitle}>{t('chat.bubble.saveAsSticker')}</Text>}
    >
      <TextInput
        style={styles.stickerNameInput}
        value={draft}
        onChangeText={onChangeDraft}
        placeholder={t('chat.sticker.namePlaceholder')}
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
          <Text style={styles.selectButtonText}>{t('common.cancel')}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.selectButton, stickerSaving && styles.sendButtonDisabled]}
          onPress={confirmStickerName}
          disabled={stickerSaving}
          activeOpacity={0.8}
        >
          <Text style={styles.selectButtonText}>{stickerSaving ? t('chat.sticker.saving') : t('common.save')}</Text>
        </TouchableOpacity>
      </View>
    </Sheet>
  );
}
