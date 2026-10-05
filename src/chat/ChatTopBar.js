// 聊天页顶栏（消息多选态 + 常规态）。从 src/ChatScreen.js 原样外提（无行为变化）。

import React, { useMemo } from 'react';
import { Image, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme } from '../theme/ThemeContext.js';
import { useTranslation } from '../i18n/I18nContext.js';
import { createChatStyles } from './chatStyles.js';

export default function ChatTopBar({
  messageSelectionOpen,
  selectedCount,
  isSending,
  onCancelSelection,
  onToggleSelectAll,
  allSelected,
  onDeleteSelected,
  onOpenSwitcher,
  loaded,
  isGroup,
  groupAvatarUri,
  characterAvatarUri,
  displayName,
  onOpenMore,
}) {
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
  const styles = useMemo(() => createChatStyles(theme, fonts, tokens), [theme, fonts, tokens]);

  return (
    <View style={styles.topBar}>
      {messageSelectionOpen ? (
        <>
          <TouchableOpacity
            style={styles.selectionAction}
            onPress={onCancelSelection}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel={t('chat.topBar.a11y.cancelSelection')}
          >
            <Ionicons name="close" size={16} color={theme.colors.primarySoft} />
            <Text style={styles.selectionActionText}>{t('chat.topBar.selection.cancel')}</Text>
          </TouchableOpacity>
          <Text style={styles.selectionCount}>{t('chat.topBar.selection.count', { count: selectedCount })}</Text>
          <View style={styles.selectionActions}>
            <TouchableOpacity
              style={[styles.selectionAction, isSending && styles.actionDisabled]}
              onPress={onToggleSelectAll}
              disabled={isSending}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={allSelected ? t('chat.topBar.a11y.unselectAll') : t('chat.topBar.a11y.selectAll')}
            >
              <Ionicons
                name={allSelected ? 'checkmark-done' : 'checkmark-done-outline'}
                size={16}
                color={theme.colors.primarySoft}
              />
              <Text style={styles.selectionActionText}>{allSelected ? t('chat.topBar.selection.unselectAll') : t('chat.topBar.selection.selectAll')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.selectionAction, styles.selectionDeleteAction, isSending && styles.actionDisabled]}
              onPress={onDeleteSelected}
              disabled={isSending}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={t('chat.topBar.a11y.deleteSelected')}
            >
              <Ionicons name="trash-outline" size={16} color={theme.colors.danger} />
              <Text style={[styles.selectionActionText, styles.selectionDeleteText]}>{t('chat.topBar.selection.delete')}</Text>
            </TouchableOpacity>
          </View>
        </>
      ) : (
        <>
          <TouchableOpacity
            style={styles.characterChip}
            onPress={onOpenSwitcher}
            disabled={!loaded}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel={isGroup ? t('chat.topBar.a11y.switchGroup') : t('chat.topBar.a11y.switchCharacter')}
            accessibilityState={{ disabled: !loaded }}
          >
            {isGroup ? (
              groupAvatarUri ? (
                <Image source={{ uri: groupAvatarUri }} style={styles.characterAvatar} />
              ) : (
                <View style={[styles.characterAvatar, styles.characterAvatarFallback]}>
                  <Ionicons name="people" size={13} color={theme.colors.primarySoft} />
                </View>
              )
            ) : characterAvatarUri ? (
              <Image source={{ uri: characterAvatarUri }} style={styles.characterAvatar} />
            ) : (
              <View style={[styles.characterAvatar, styles.characterAvatarFallback]}>
                <Ionicons name="person" size={13} color={theme.colors.primarySoft} />
              </View>
            )}
            <Text style={styles.characterName} numberOfLines={1}>
              {displayName}
            </Text>
            <Ionicons name="chevron-down" size={14} color={theme.colors.primaryMuted} style={styles.characterCaret} />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.noticeButton}
            onPress={onOpenMore}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel={t('chat.topBar.a11y.more')}
          >
            <Ionicons name="ellipsis-horizontal" size={15} color={theme.colors.primarySoft} />
          </TouchableOpacity>
        </>
      )}
    </View>
  );
}
