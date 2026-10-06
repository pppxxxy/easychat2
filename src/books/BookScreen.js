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
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import {
  Card,
  Chip,
  CollectionNameModal,
  CollectionPickerModal,
  EmptyState,
  GhostButton,
  IconButton,
} from '../ui/index.js';
import { useNavigation } from '@react-navigation/native';
import { useTheme } from '../theme/ThemeContext.js';

import PaneHeader from '../ui/PaneHeader.js';
import * as FileSystem from 'expo-file-system/legacy';

import { useTranslation } from '../i18n/I18nContext.js';

import { deleteBookCommentsForBooks } from './comments.js';
import { deleteBooks, getBooks, readBookContent } from './library.js';
import {
  SHELF_NAME_MAX,
  createBookShelf,
  deleteBookShelf,
  getBookShelves,
  purgeBooksFromShelves,
  renameBookShelf,
  setBookInShelf,
} from './shelves.js';
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

function BookRow({ item, onPress, onDelete, onMore, styles, theme, t }) {
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
        name="ellipsis-horizontal"
        accessibilityLabel={t('books.a11y.bookMore', { name: item.name })}
        onPress={onMore}
        style={styles.rowMore}
      />
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
  const navigation = useNavigation();
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
  // 书架分组（同歌单）：列表 + 当前筛选（'' = 全部）+ 命名弹窗 + 「加入/移出分组」选择器。
  const [shelves, setShelves] = useState([]);
  const [shelfFilter, setShelfFilter] = useState('');
  const [shelfPrompt, setShelfPrompt] = useState({
    visible: false,
    mode: 'create',
    shelfId: '',
    draft: '',
  });
  const [shelfSaving, setShelfSaving] = useState(false);
  const [shelfPickerBookId, setShelfPickerBookId] = useState('');
  // 书名搜索（书多了靠它找）。
  const [query, setQuery] = useState('');

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

  const reloadShelves = useCallback(async () => {
    try {
      setShelves(await getBookShelves());
    } catch (error) {
      // 分组读取失败不阻断看书：保持当前列表，避免把界面清空成「没有分组」误导用户。
    }
  }, []);

  useEffect(() => {
    reloadShelves();
  }, [reloadShelves]);

  const activeShelf = useMemo(
    () => shelves.find(item => item.id === shelfFilter) || null,
    [shelves, shelfFilter]
  );
  const visibleBooks = useMemo(() => {
    const keyword = String(query || '').trim().toLowerCase();
    return books.filter(item => {
      if (activeShelf && !activeShelf.bookIds.includes(item.id)) return false;
      if (keyword && !String(item.name || '').toLowerCase().includes(keyword)) return false;
      return true;
    });
  }, [books, activeShelf, query]);
  const shelfPickerBook = useMemo(
    () => books.find(item => item.id === shelfPickerBookId) || null,
    [books, shelfPickerBookId]
  );

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
            // 分组里的引用同步清掉（失败不阻断删除，渲染侧也会按书库过滤）。
            purgeBooksFromShelves([item.id])
              .then(changed => {
                if (changed) reloadShelves().catch(() => {});
              })
              .catch(() => {});
            FileSystem.deleteAsync(item.uri, { idempotent: true }).catch(() => {});
          },
        },
      ]
    );
  }, [reloadShelves]);

  // ---- 书架分组 ----

  const openCreateShelf = useCallback(() => {
    setShelfPrompt({ visible: true, mode: 'create', shelfId: '', draft: '' });
  }, []);

  const openRenameShelf = useCallback(shelf => {
    if (!shelf) return;
    setShelfPrompt({
      visible: true,
      mode: 'rename',
      shelfId: shelf.id,
      draft: shelf.name,
    });
  }, []);

  const closeShelfPrompt = useCallback(() => {
    if (shelfSaving) return;
    setShelfPrompt({ visible: false, mode: 'create', shelfId: '', draft: '' });
  }, [shelfSaving]);

  const confirmShelfName = useCallback(async () => {
    if (shelfSaving) return;
    const name = String(shelfPrompt.draft || '').trim();
    if (!name) {
      Alert.alert(t('books.shelves.title'), t('books.shelves.nameEmpty'));
      return;
    }
    const duplicated = shelves.some(item => (
      item.name === name
      && (shelfPrompt.mode === 'create' || item.id !== shelfPrompt.shelfId)
    ));
    if (duplicated) {
      Alert.alert(t('books.shelves.title'), t('books.shelves.duplicate'));
      return;
    }
    setShelfSaving(true);
    try {
      if (shelfPrompt.mode === 'rename') {
        await renameBookShelf(shelfPrompt.shelfId, name);
      } else {
        await createBookShelf(name);
      }
      await reloadShelves();
      setShelfPrompt({ visible: false, mode: 'create', shelfId: '', draft: '' });
    } catch (error) {
      Alert.alert(t('books.shelves.title'), t('books.shelves.saveFailed'));
    } finally {
      setShelfSaving(false);
    }
  }, [shelfPrompt, shelfSaving, shelves, reloadShelves, t]);

  const confirmDeleteShelf = useCallback(shelf => {
    if (!shelf) return;
    Alert.alert(
      t('books.shelves.delete.title'),
      t('books.shelves.delete.body', { name: shelf.name }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: () => {
            deleteBookShelf(shelf.id)
              .then(() => {
                setShelfFilter(current => (current === shelf.id ? '' : current));
                return reloadShelves();
              })
              .catch(() => {
                Alert.alert(t('books.shelves.title'), t('books.shelves.saveFailed'));
              });
          },
        },
      ]
    );
  }, [reloadShelves, t]);

  // 在「加入/移出分组」弹窗里勾选：只更新目标分组，其余保持不动。
  const toggleBookInShelf = useCallback((shelf, included) => {
    const bookId = shelfPickerBookId;
    if (!bookId || !shelf) return;
    setBookInShelf(shelf.id, bookId, included)
      .then(updated => {
        setShelves(list => list.map(item => (item.id === updated.id ? updated : item)));
      })
      .catch(() => {
        Alert.alert(t('books.shelves.title'), t('books.shelves.saveFailed'));
      });
  }, [shelfPickerBookId, t]);

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
      <PaneHeader
        title={t('books.title')}
        onBack={() => navigation.goBack()}
        right={(
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
        )}
      />

      <View style={styles.searchRow}>
        <Ionicons name="search" size={15} color={theme.colors.textFaint} />
        <TextInput
          style={styles.searchInput}
          value={query}
          onChangeText={setQuery}
          placeholder={t('books.search.placeholder')}
          placeholderTextColor={theme.colors.textFaint}
          returnKeyType="search"
          autoCorrect={false}
        />
        {query ? (
          <TouchableOpacity
            onPress={() => setQuery('')}
            accessibilityRole="button"
            accessibilityLabel={t('books.search.clear')}
          >
            <Ionicons name="close-circle" size={16} color={theme.colors.textFaint} />
          </TouchableOpacity>
        ) : null}
      </View>

      <ScrollView contentContainerStyle={styles.listContent} keyboardShouldPersistTaps="handled">
        {opening ? (
          <View style={styles.centerSmall}>
            <ActivityIndicator color={theme.colors.primary} />
          </View>
        ) : null}

        <Card style={styles.shelfCard}>
          <View style={styles.shelfHeader}>
            <Text style={styles.shelfTitle}>{t('books.shelves.title')}</Text>
            <TouchableOpacity
              style={styles.shelfCreate}
              onPress={openCreateShelf}
              activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityLabel={t('books.shelves.create')}
            >
              <Ionicons name="add" size={16} color={theme.colors.primary} />
              <Text style={styles.shelfCreateText}>{t('books.shelves.create')}</Text>
            </TouchableOpacity>
          </View>
          {shelves.length === 0 ? (
            <Text style={styles.shelfEmpty}>{t('books.shelves.empty')}</Text>
          ) : (
            <>
              <View style={styles.shelfChips}>
                <Chip
                  label={t('books.shelves.all')}
                  active={!activeShelf}
                  onPress={() => setShelfFilter('')}
                />
                {shelves.map(shelf => (
                  <Chip
                    key={shelf.id}
                    label={t('books.shelves.chip', {
                      name: shelf.name,
                      count: shelf.bookIds.length,
                    })}
                    active={activeShelf?.id === shelf.id}
                    onPress={() => setShelfFilter(shelf.id)}
                  />
                ))}
              </View>
              {activeShelf ? (
                <View style={styles.shelfActions}>
                  <TouchableOpacity
                    style={styles.shelfAction}
                    onPress={() => openRenameShelf(activeShelf)}
                    activeOpacity={0.85}
                    accessibilityRole="button"
                    accessibilityLabel={t('books.shelves.rename')}
                  >
                    <Ionicons name="create-outline" size={14} color={theme.colors.primary} />
                    <Text style={styles.shelfActionText}>{t('books.shelves.rename')}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.shelfAction}
                    onPress={() => confirmDeleteShelf(activeShelf)}
                    activeOpacity={0.85}
                    accessibilityRole="button"
                    accessibilityLabel={t('books.shelves.delete')}
                  >
                    <Ionicons
                      name="trash-outline"
                      size={14}
                      color={theme.colors.danger || theme.colors.text}
                    />
                    <Text style={[styles.shelfActionText, styles.shelfActionDanger]}>
                      {t('books.shelves.delete')}
                    </Text>
                  </TouchableOpacity>
                </View>
              ) : null}
            </>
          )}
        </Card>

        {activeShelf || query.trim() ? (
          <Text style={styles.filterHint}>
            {activeShelf && query.trim()
              ? t('books.filter.both', { shelf: activeShelf.name, keyword: query.trim(), count: visibleBooks.length })
              : activeShelf
                ? t('books.filter.shelf', { shelf: activeShelf.name, count: visibleBooks.length })
                : t('books.filter.keyword', { keyword: query.trim(), count: visibleBooks.length })}
          </Text>
        ) : null}

        {books.length === 0 && !opening ? (
          <EmptyState
            icon="book-outline"
            title={t('books.empty.title')}
            description={t('books.empty.body')}
          />
        ) : visibleBooks.length === 0 && !opening ? (
          <EmptyState
            icon="search-outline"
            title={activeShelf ? t('books.shelves.filterEmpty.title') : t('books.search.empty.title')}
            description={activeShelf
              ? t('books.shelves.filterEmpty.body')
              : t('books.search.empty.body')}
          />
        ) : visibleBooks.map(item => (
          <BookRow
            key={item.id}
            item={item}
            onPress={() => handleOpen(item)}
            onDelete={() => handleDelete(item)}
            onMore={() => setShelfPickerBookId(item.id)}
            styles={styles}
            theme={theme}
            t={t}
          />
        ))}
      </ScrollView>

      <CollectionNameModal
        visible={shelfPrompt.visible}
        title={shelfPrompt.mode === 'rename'
          ? t('books.shelves.rename.title')
          : t('books.shelves.create.title')}
        placeholder={t('books.shelves.namePlaceholder')}
        cancelLabel={t('common.cancel')}
        confirmLabel={t('common.confirm')}
        savingLabel={t('books.shelves.saving')}
        maxLength={SHELF_NAME_MAX}
        draft={shelfPrompt.draft}
        saving={shelfSaving}
        onChangeDraft={draft => setShelfPrompt(previous => ({ ...previous, draft }))}
        onClose={closeShelfPrompt}
        onConfirm={confirmShelfName}
      />
      <CollectionPickerModal
        visible={!!shelfPickerBook}
        title={t('books.shelves.picker.title')}
        subtitle={shelfPickerBook ? shelfPickerBook.name : ''}
        hint={t('books.shelves.picker.hint')}
        emptyHint={t('books.shelves.picker.noShelves')}
        doneLabel={t('common.done')}
        items={shelves}
        itemKey={shelf => shelf.id}
        itemLabel={shelf => shelf.name}
        itemMeta={shelf => t('books.shelves.count', { count: shelf.bookIds.length })}
        isIncluded={shelf => shelf.bookIds.includes(shelfPickerBookId)}
        onToggle={toggleBookInShelf}
        onClose={() => setShelfPickerBookId('')}
      />
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
  rowMore: { marginRight: 4 },
  rowDelete: { marginRight: 10 },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 20,
    marginBottom: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: tokens.radius.md,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    backgroundColor: theme.colors.surfaceAlt,
  },
  searchInput: {
    flex: 1,
    marginLeft: 8,
    marginRight: 6,
    color: theme.colors.text,
    fontSize: fonts.scaled(14),
    paddingVertical: 2,
  },
  shelfCard: { marginBottom: tokens.metrics.cardGap },
  shelfHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  shelfTitle: { color: theme.colors.text, fontSize: fonts.scaled(15), fontWeight: '700' },
  shelfCreate: { flexDirection: 'row', alignItems: 'center' },
  shelfCreateText: { color: theme.colors.primary, fontSize: fonts.scaled(13), fontWeight: '600', marginLeft: 4 },
  shelfEmpty: { color: theme.colors.textFaint, fontSize: fonts.scaled(12), lineHeight: fonts.scaled(17) },
  shelfChips: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' },
  shelfActions: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
  shelfAction: { flexDirection: 'row', alignItems: 'center', marginRight: 18 },
  shelfActionText: { color: theme.colors.primary, fontSize: fonts.scaled(12), fontWeight: '600', marginLeft: 4 },
  shelfActionDanger: { color: theme.colors.danger || theme.colors.text },
  filterHint: {
    color: theme.colors.textMuted,
    fontSize: fonts.scaled(12),
    marginBottom: 8,
    lineHeight: fonts.scaled(17),
  },
});
