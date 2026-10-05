// 工作区对话历史：列出当前角色保存下来的工作区会话，可切换 / 删除 / 清空。
//
// 纯展示 + 回调：数据由 WorkspaceChat 从存储读出后传进来，动作也交给它执行
//（那边才持有「当前会话」与「正在生成」的状态，能决定切换前是否需要中止请求）。

import React, { useMemo } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme } from '../theme/ThemeContext.js';
import { useTranslation } from '../i18n/I18nContext.js';

function formatTime(at) {
  const date = new Date(Number(at) || 0);
  if (!Number.isFinite(date.getTime()) || date.getTime() <= 0) return '';
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export default function WorkspaceHistorySheet({
  visible,
  onClose,
  chats = [],
  activeChatId = '',
  onSelectChat,
  onDeleteChat,
  onClearAll,
  busy = false,
}) {
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);

  const confirmDelete = chat => {
    Alert.alert(
      t('workspace.history.delete.title'),
      t('workspace.history.delete.body', { name: chat.title || t('workspace.history.untitled') }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('workspace.history.delete.ok'), style: 'destructive', onPress: () => onDeleteChat && onDeleteChat(chat.id) },
      ]
    );
  };

  const confirmClear = () => {
    Alert.alert(
      t('workspace.history.clear.title'),
      t('workspace.history.clear.body'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('workspace.history.clear.ok'), style: 'destructive', onPress: () => onClearAll && onClearAll() },
      ]
    );
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>{t('workspace.history.title')}</Text>
            <View style={styles.headerActions}>
              {chats.length > 0 ? (
                <TouchableOpacity onPress={confirmClear} hitSlop={8} style={styles.clearButton}>
                  <Text style={styles.clearText}>{t('workspace.history.clear.action')}</Text>
                </TouchableOpacity>
              ) : null}
              <TouchableOpacity onPress={onClose} hitSlop={8}>
                <Ionicons name="close" size={20} color={theme.colors.textMuted} />
              </TouchableOpacity>
            </View>
          </View>

          {busy ? (
            <View style={styles.center}>
              <ActivityIndicator color={theme.colors.primary} />
            </View>
          ) : chats.length === 0 ? (
            <View style={styles.center}>
              <Ionicons name="chatbubbles-outline" size={30} color={theme.colors.textFaint} />
              <Text style={styles.emptyText}>{t('workspace.history.empty')}</Text>
            </View>
          ) : (
            <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
              {chats.map(chat => {
                const active = String(chat.id) === String(activeChatId);
                const preview = chat.messages.length
                  ? String(chat.messages[chat.messages.length - 1].content || '').split('\n')[0]
                  : '';
                return (
                  <TouchableOpacity
                    key={chat.id}
                    style={[styles.row, active && styles.rowActive]}
                    onPress={() => onSelectChat && onSelectChat(chat.id)}
                    onLongPress={() => confirmDelete(chat)}
                    activeOpacity={0.8}
                  >
                    <Ionicons
                      name={active ? 'radio-button-on' : 'chatbubble-outline'}
                      size={16}
                      color={active ? theme.colors.primary : theme.colors.textFaint}
                    />
                    <View style={styles.rowTextBlock}>
                      <Text style={[styles.rowTitle, active && styles.rowTitleActive]} numberOfLines={1}>
                        {chat.title || t('workspace.history.untitled')}
                      </Text>
                      <Text style={styles.rowMeta} numberOfLines={1}>
                        {`${formatTime(chat.updatedAt)} · ${t('workspace.history.count', { count: chat.messages.length })}`}
                      </Text>
                      {preview ? (
                        <Text style={styles.rowPreview} numberOfLines={1}>{preview}</Text>
                      ) : null}
                    </View>
                    <TouchableOpacity onPress={() => confirmDelete(chat)} hitSlop={8} style={styles.deleteButton}>
                      <Ionicons name="trash-outline" size={15} color={theme.colors.textFaint} />
                    </TouchableOpacity>
                  </TouchableOpacity>
                );
              })}
              <Text style={styles.hint}>{t('workspace.history.hint')}</Text>
            </ScrollView>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: theme.colors.overlay,
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: theme.colors.surfaceAlt,
    borderTopLeftRadius: tokens.radius.lg,
    borderTopRightRadius: tokens.radius.lg,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.divider,
    maxHeight: '80%',
    paddingBottom: 10,
    ...tokens.elevation(2, theme),
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: tokens.border.thin,
    borderBottomColor: theme.colors.divider,
  },
  sheetTitle: { color: theme.colors.text, fontSize: fonts.scaled(15), fontWeight: '800' },
  headerActions: { flexDirection: 'row', alignItems: 'center' },
  clearButton: { marginRight: 14 },
  clearText: { color: theme.colors.danger || theme.colors.textMuted, fontSize: fonts.scaled(12), fontWeight: '600' },
  center: { alignItems: 'center', paddingVertical: 38 },
  emptyText: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(12),
    marginTop: 10,
    textAlign: 'center',
    paddingHorizontal: 24,
  },
  list: { flexGrow: 0 },
  listContent: { paddingHorizontal: 12, paddingBottom: 10 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    borderRadius: tokens.radius.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginTop: 8,
  },
  rowActive: {
    backgroundColor: theme.colors.primaryAlpha(0.15),
    borderColor: theme.colors.primary,
  },
  rowTextBlock: { flex: 1, marginLeft: 10, marginRight: 8 },
  rowTitle: { color: theme.colors.text, fontSize: fonts.scaled(13), fontWeight: '600' },
  rowTitleActive: { color: theme.colors.primarySoft },
  rowMeta: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), marginTop: 3 },
  rowPreview: { color: theme.colors.textMuted, fontSize: fonts.scaled(11), marginTop: 3 },
  deleteButton: { padding: 4 },
  hint: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(11),
    lineHeight: fonts.scaled(16),
    marginTop: 14,
    paddingHorizontal: 4,
  },
});
