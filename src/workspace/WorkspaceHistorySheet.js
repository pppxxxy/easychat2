// 工作区对话历史：列出当前角色保存下来的工作区会话，可切换 / 删除 / 清空。
//
// 纯展示 + 回调：数据由 WorkspaceChat 从存储读出后传进来，动作也交给它执行
//（那边才持有「当前会话」与「正在生成」的状态，能决定切换前是否需要中止请求）。

import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme } from '../theme/ThemeContext.js';
import { useTranslation } from '../i18n/I18nContext.js';
import {
  CHAT_SORT_MODES,
  DEFAULT_CHAT_SORT,
  buildChatHistoryView,
  chatMessageCount,
  chatPreview,
} from './chatHistoryView.js';

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
  onArchiveChat,
  onClearAll,
  busy = false,
}) {
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  // I5：归档视图——主视图只看未归档；有归档会话时出现「已归档（N）」切换。
  const [showArchived, setShowArchived] = useState(false);
  // P2-2：检索与排序都走纯函数（workspace/chatHistoryView.js），面板只渲染结果。
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState(DEFAULT_CHAT_SORT);
  const archivedCount = chats.filter(chat => chat.archived === true).length;
  const visibleChats = useMemo(
    () => buildChatHistoryView(chats, { query, archived: showArchived, sort }),
    [chats, query, showArchived, sort]
  );

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
              {archivedCount > 0 ? (
                <TouchableOpacity
                  onPress={() => setShowArchived(value => !value)}
                  hitSlop={8}
                  style={[styles.clearButton, showArchived && styles.archiveTabActive]}
                >
                  <Text style={[styles.clearText, showArchived && styles.archiveTabTextActive]}>
                    {t('workspace.history.archivedTab', { count: archivedCount })}
                  </Text>
                </TouchableOpacity>
              ) : null}
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

          {/* P2-2：检索 + 排序。会话一多就只能滚动翻找，这里给搜索框与两种时间序
              （只提供基于时间的顺序：按标题排要 localeCompare 的 ICU 数据，
              Hermes 上中文会按码位排、看着像乱序，宁可不给）。 */}
          {chats.length > 0 ? (
            <View style={styles.toolbar}>
              <View style={styles.searchBox}>
                <Ionicons name="search" size={14} color={theme.colors.textFaint} />
                <TextInput
                  style={styles.searchInput}
                  value={query}
                  onChangeText={setQuery}
                  placeholder={t('workspace.history.search.placeholder')}
                  placeholderTextColor={theme.colors.textFaint}
                  returnKeyType="search"
                  autoCorrect={false}
                  autoCapitalize="none"
                />
                {query ? (
                  <TouchableOpacity onPress={() => setQuery('')} hitSlop={8} accessibilityLabel={t('common.cancel')}>
                    <Ionicons name="close-circle" size={15} color={theme.colors.textFaint} />
                  </TouchableOpacity>
                ) : null}
              </View>
              {CHAT_SORT_MODES.map(mode => (
                <TouchableOpacity
                  key={mode}
                  style={[styles.sortChip, sort === mode && styles.sortChipActive]}
                  onPress={() => setSort(mode)}
                  activeOpacity={0.8}
                  accessibilityRole="button"
                >
                  <Text style={[styles.sortChipText, sort === mode && styles.sortChipTextActive]}>
                    {t(`workspace.history.sort.${mode}`)}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          ) : null}

          {busy ? (
            <View style={styles.center}>
              <ActivityIndicator color={theme.colors.primary} />
            </View>
          ) : visibleChats.length === 0 ? (
            <View style={styles.center}>
              <Ionicons
                name={query ? 'search-outline' : 'chatbubbles-outline'}
                size={30}
                color={theme.colors.textFaint}
              />
              <Text style={styles.emptyText}>
                {query
                  ? t('workspace.history.search.empty')
                  : (showArchived ? t('workspace.history.emptyArchived') : t('workspace.history.empty'))}
              </Text>
            </View>
          ) : (
            <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
              {visibleChats.map(chat => {
                const active = String(chat.id) === String(activeChatId);
                const preview = chatPreview(chat);
                return (
                  <TouchableOpacity
                    key={chat.id}
                    style={[styles.row, active && styles.rowActive]}
                    onPress={() => {
                      if (showArchived) return; // 归档视图里只管理，不切换（先恢复再选）
                      onSelectChat && onSelectChat(chat.id);
                    }}
                    onLongPress={() => confirmDelete(chat)}
                    activeOpacity={0.8}
                  >
                    <Ionicons
                      name={active ? 'radio-button-on' : (chat.archived ? 'archive-outline' : 'chatbubble-outline')}
                      size={16}
                      color={active ? theme.colors.primary : theme.colors.textFaint}
                    />
                    <View style={styles.rowTextBlock}>
                      <Text style={[styles.rowTitle, active && styles.rowTitleActive]} numberOfLines={1}>
                        {chat.title || t('workspace.history.untitled')}
                      </Text>
                      <Text style={styles.rowMeta} numberOfLines={1}>
                        {`${formatTime(chat.updatedAt)} · ${t('workspace.history.count', { count: chatMessageCount(chat) })}`}
                      </Text>
                      {preview ? (
                        <Text style={styles.rowPreview} numberOfLines={1}>{preview}</Text>
                      ) : null}
                    </View>
                    {/* I5：归档/恢复（归档视图里显示恢复箭头）。 */}
                    {onArchiveChat ? (
                      <TouchableOpacity
                        onPress={() => onArchiveChat(chat.id, chat.archived !== true)}
                        hitSlop={8}
                        style={styles.deleteButton}
                      >
                        <Ionicons
                          name={chat.archived ? 'unarchive-outline' : 'archive-outline'}
                          size={15}
                          color={theme.colors.textFaint}
                        />
                      </TouchableOpacity>
                    ) : null}
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
  // P2-2：检索 + 排序工具条（贴着标题行下方，不占列表空间）。
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 10,
  },
  searchBox: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surface,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    borderRadius: tokens.radius.md,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  searchInput: { flex: 1, color: theme.colors.text, fontSize: fonts.scaled(12), marginLeft: 6, padding: 0 },
  sortChip: {
    marginLeft: 6,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 10,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
  },
  sortChipActive: {
    backgroundColor: theme.colors.primaryMuted || theme.colors.primary,
    borderColor: theme.colors.primary,
  },
  sortChipText: { color: theme.colors.textMuted, fontSize: fonts.scaled(11), fontWeight: '600' },
  sortChipTextActive: { color: theme.colors.primaryContrast || '#fff' },
  clearButton: { marginRight: 14 },
  clearText: { color: theme.colors.danger || theme.colors.textMuted, fontSize: fonts.scaled(12), fontWeight: '600' },
  // I5：归档切换 tab（激活态用主题主色描边，不与「清空」的红字混淆）。
  archiveTabActive: {
    backgroundColor: theme.colors.primaryMuted || theme.colors.primary,
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  archiveTabTextActive: { color: theme.colors.primaryContrast || '#fff' },
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
