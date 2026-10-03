// 书架面板：本地书库（导入/删除/继续阅读）+ 打开阅读器。
// 入口在「扩展 → 世界」分组；正文按需加载（打开某本书才读文件）。
// 段落陪伴评论与「接话」由 useBookComments 驱动（2026-10-03 用户裁决：评论只在
// 面板内呈现，接话才带入会话引用）。

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { EmptyState, GhostButton, IconButton } from '../ui/index.js';
import { useTheme } from '../theme/ThemeContext.js';
import * as FileSystem from 'expo-file-system/legacy';

import { deleteBookCommentsForBooks } from './comments.js';
import { deleteBooks, getBooks, readBookContent } from './library.js';
import { importBookFromPicker } from './importBook.js';
import { BookReaderView } from './BookReaderView.js';

function formatBookSize(item) {
  const parts = [];
  if (item.chars > 0) {
    parts.push(item.chars >= 10000 ? `${(item.chars / 10000).toFixed(1)} 万字` : `${item.chars} 字`);
  } else if (item.size > 0) {
    parts.push(item.size >= 1024 * 1024 ? `${(item.size / (1024 * 1024)).toFixed(1)}MB` : `${Math.round(item.size / 1024)}KB`);
  }
  if (item.chapters.length > 0) parts.push(`${item.chapters.length} 章`);
  const hasProgress = item.progress.blockIndex > 0 || item.progress.pageIndex > 0;
  if (hasProgress) parts.push('上次读到');
  return parts.join(' · ');
}

function BookRow({ item, onPress, onDelete, styles, theme }) {
  return (
    <View style={styles.row}>
      <TouchableOpacity style={styles.rowMain} onPress={onPress} activeOpacity={0.8}>
        <View style={styles.rowIcon}>
          <Ionicons name="book" size={16} color={theme.colors.primaryContrast} />
        </View>
        <View style={styles.rowBody}>
          <Text style={styles.rowName} numberOfLines={1}>{item.name}</Text>
          <Text style={styles.rowMeta} numberOfLines={1}>
            {formatBookSize(item) || '文本'}
          </Text>
        </View>
      </TouchableOpacity>
      <IconButton
        name="trash-outline"
        accessibilityLabel={`删除 ${item.name}`}
        onPress={onDelete}
        style={styles.rowDelete}
      />
    </View>
  );
}

export default function BookScreen() {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);

  const [books, setBooks] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [importing, setImporting] = useState(false);
  const [opening, setOpening] = useState(false);
  // 打开的书：{ item, content }；key=item.id 让阅读器整树重挂载，省去复位逻辑。
  const [openBook, setOpenBook] = useState(null);

  const reload = useCallback(async () => {
    try {
      const list = await getBooks();
      setBooks(list);
      setLoaded(true);
      setLoadFailed(false);
    } catch (error) {
      setLoaded(true);
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const handleImport = useCallback(async () => {
    if (importing) return;
    setImporting(true);
    try {
      const { item } = await importBookFromPicker();
      if (!item) return;
      setBooks(list => [item, ...list.filter(entry => entry.id !== item.id)]);
    } catch (error) {
      const code = error && error.code;
      if (code === 'UNSUPPORTED_FORMAT') {
        Alert.alert('格式不支持', '目前只支持 txt 与 Markdown 文本文件。');
      } else if (code === 'ENCODING') {
        Alert.alert('编码不支持', error.message);
      } else {
        Alert.alert('导入失败', '无法读取所选文件，请重试。');
      }
    } finally {
      setImporting(false);
    }
  }, [importing]);

  const handleOpen = useCallback(async item => {
    if (opening || !item) return;
    setOpening(true);
    try {
      const content = await readBookContent(item);
      setOpenBook({ item, content });
    } catch (error) {
      Alert.alert('打开失败', '书籍文件读取失败，可能已被清理，请删除后重新导入。');
    } finally {
      setOpening(false);
    }
  }, [opening]);

  const handleCloseReader = useCallback(() => {
    setOpenBook(null);
    reload();
  }, [reload]);

  const handleDelete = useCallback(item => {
    if (!item) return;
    Alert.alert(
      '删除书籍',
      `确定从书架删除「${item.name}」吗？书籍文件与它的评论会一并删除。`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: '删除',
          style: 'destructive',
          onPress: () => {
            setBooks(list => list.filter(entry => entry.id !== item.id));
            deleteBooks([item.id]).catch(() => {});
            deleteBookCommentsForBooks([item.id]).catch(() => {});
            FileSystem.deleteAsync(item.uri, { idempotent: true }).catch(() => {});
          },
        },
      ]
    );
  }, []);

  if (!loaded) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={theme.colors.primary} />
      </View>
    );
  }

  if (loadFailed) {
    return (
      <EmptyState
        icon="alert-circle-outline"
        title="书架读取失败"
        description="书架记录读取失败，请稍后重试。"
        action={<GhostButton title="重试" onPress={reload} />}
      />
    );
  }

  if (openBook) {
    return (
      <BookReaderView
        key={openBook.item.id}
        item={openBook.item}
        content={openBook.content}
        onBack={handleCloseReader}
      />
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>一起看书</Text>
        <TouchableOpacity
          style={styles.importButton}
          onPress={handleImport}
          disabled={importing}
          activeOpacity={0.85}
        >
          {importing
            ? <ActivityIndicator size="small" color={theme.colors.primaryContrast} />
            : <Ionicons name="add" size={16} color={theme.colors.primaryContrast} />}
          <Text style={styles.importText}>导入本地书籍</Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.listContent}>
        {opening ? (
          <View style={styles.centerSmall}>
            <ActivityIndicator color={theme.colors.primary} />
          </View>
        ) : null}
        {books.length === 0 && !opening ? (
          <EmptyState
            icon="book-outline"
            title="书架还是空的"
            description="导入本地的 txt / Markdown 小说，和角色一起读。"
          />
        ) : books.map(item => (
          <BookRow
            key={item.id}
            item={item}
            onPress={() => handleOpen(item)}
            onDelete={() => handleDelete(item)}
            styles={styles}
            theme={theme}
          />
        ))}
      </ScrollView>
    </View>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  centerSmall: { alignItems: 'center', justifyContent: 'center', paddingVertical: 14 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 4,
    paddingBottom: 10,
  },
  headerTitle: { color: theme.colors.text, fontSize: fonts.scaled(16), fontWeight: '700' },
  importButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.primary,
    borderRadius: tokens.metrics.buttonRadius,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  importText: { color: theme.colors.primaryContrast, fontSize: fonts.scaled(13), fontWeight: '600', marginLeft: 4 },
  listContent: { paddingHorizontal: 20, paddingBottom: 30 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surface,
    borderRadius: tokens.metrics.cardRadius,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    marginBottom: tokens.metrics.cardGap,
    ...tokens.elevation(1, theme),
  },
  rowMain: { flex: 1, flexDirection: 'row', alignItems: 'center', padding: tokens.metrics.cardPadding },
  rowIcon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: theme.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  rowBody: { flex: 1, marginRight: 8 },
  rowName: { color: theme.colors.text, fontSize: fonts.scaled(14), fontWeight: '600' },
  rowMeta: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), marginTop: 3 },
  rowDelete: { marginRight: 10 },
});
