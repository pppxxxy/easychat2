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

import { useTranslation } from '../i18n/I18nContext.js';

import { deleteBookCommentsForBooks } from './comments.js';
import { deleteBooks, getBooks, readBookContent } from './library.js';
import { importBookFromPicker } from './importBook.js';
// BookReaderView 是 default 导出——具名导入拿到 undefined，打开书即崩
//（"Element type is invalid ... got: undefined"，真机上只有打开书才触发）。
import BookReaderView from './BookReaderView.js';

function formatBookSize(item, t) {
  const parts = [];
  if (item.chars > 0) {
    // 中文用「万」（除以 1 万），英文用「k chars」（除以 1 千）——单位不同，
    // 因此两个数值都要传，由各自语言的词条决定用哪个（词条里只出现自己那个占位符）。
    parts.push(item.chars >= 10000
      ? t('books.list.chars.tenThousand', {
        wan: (item.chars / 10000).toFixed(1),
        k: Math.round(item.chars / 1000),
      })
      : t('books.list.chars', { count: item.chars }));
  } else if (item.size > 0) {
    parts.push(item.size >= 1024 * 1024 ? `${(item.size / (1024 * 1024)).toFixed(1)}MB` : `${Math.round(item.size / 1024)}KB`);
  }
  if (item.chapters.length > 0) parts.push(t('books.list.chapters', { count: item.chapters.length }));
  const hasProgress = item.progress.blockIndex > 0 || item.progress.pageIndex > 0;
  if (hasProgress) parts.push(t('books.list.continueReading'));
  return parts.join(' · ');
}

function BookRow({ item, onPress, onDelete, styles, theme, t }) {
  return (
    <View style={styles.row}>
      <TouchableOpacity style={styles.rowMain} onPress={onPress} activeOpacity={0.8}>
        <View style={styles.rowIcon}>
          <Ionicons name="book" size={16} color={theme.colors.primaryContrast} />
        </View>
        <View style={styles.rowBody}>
          <Text style={styles.rowName} numberOfLines={1}>{item.name}</Text>
          <Text style={styles.rowMeta} numberOfLines={1}>
            {formatBookSize(item, t) || t('books.list.text')}
          </Text>
        </View>
      </TouchableOpacity>
      <IconButton
        name="trash-outline"
        accessibilityLabel={t('books.a11y.deleteBook', { name: item.name })}
        onPress={onDelete}
        style={styles.rowDelete}
      />
    </View>
  );
}

export default function BookScreen() {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const { t } = useTranslation();

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
      // 一律走文案键，不把原始报错文本渲染给用户：抛错文本面向开发者且是中文，
      // 直接透传会让英文界面冒出中文（locale 测试只扫文案表，扫不到运行时抛出的报错文本）。
      const code = error && error.code;
      if (code === 'UNSUPPORTED_FORMAT') {
        Alert.alert(t('books.import.unsupported.title'), t('books.import.unsupported.body'));
      } else if (code === 'NOT_TEXT') {
        Alert.alert(t('books.import.notText.title'), t('books.import.notText.body'));
      } else if (code === 'ENCODING') {
        Alert.alert(t('books.import.encoding.title'), t('books.import.encoding.body'));
      } else if (code === 'DOCX_TOO_LARGE') {
        Alert.alert(t('books.import.docxTooLarge.title'), t('books.import.docxTooLarge.body'));
      } else if (code === 'EMPTY_BOOK') {
        Alert.alert(t('books.import.empty.title'), t('books.import.empty.body'));
      } else {
        Alert.alert(t('books.import.failed.title'), t('books.import.failed.body'));
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
      Alert.alert(t('books.open.failed.title'), t('books.open.failed.body'));
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
      t('books.delete.title'),
      t('books.delete.body', { name: item.name }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
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
        title={t('books.load.failed.title')}
        description={t('books.load.failed.body')}
        action={<GhostButton title={t('common.retry')} onPress={reload} />}
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
        <Text style={styles.headerTitle}>{t('books.title')}</Text>
        <TouchableOpacity
          style={styles.importButton}
          onPress={handleImport}
          disabled={importing}
          activeOpacity={0.85}
        >
          {importing
            ? <ActivityIndicator size="small" color={theme.colors.primaryContrast} />
            : <Ionicons name="add" size={16} color={theme.colors.primaryContrast} />}
          <Text style={styles.importText}>{t('books.import')}</Text>
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
            title={t('books.empty.title')}
            description={t('books.empty.body')}
          />
        ) : books.map(item => (
          <BookRow
            key={item.id}
            item={item}
            onPress={() => handleOpen(item)}
            onDelete={() => handleDelete(item)}
            styles={styles}
            theme={theme}
            t={t}
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
