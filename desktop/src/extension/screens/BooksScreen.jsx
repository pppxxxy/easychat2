// 书籍（桌面）：导入 txt/md 与阅读。
//
// 复用共享层：
//   · books/library.js —— getBooks / saveBookItem / readBookContent / saveBookProgress
//     （含分键损坏保护、来源格式判定、按章进度）；书籍正文本来就落在 documents/books/，
//     readBookContent 走 expo-file-system 适配层，桌面已支持；
//   · books/library.js 的 chapters 结构决定阅读器是「整本滚动」还是「按章翻」。
//
// 桌面相比手机少的：DOCX 解析（手机侧由原生/第三方库完成）与 Markdown 富渲染
// （桌面用纯文本 + 简单排版，够读）。导入时把这两种情况如实告知，不假装支持。
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useTranslation } from '../../../../src/i18n/I18nContext.js';
import {
  BOOKS_DIR_NAME,
  deleteBooks,
  getBooks,
  normalizeBookItem,
  readBookContent,
  saveBookItem,
  saveBookProgress,
} from '../../../../src/books/library.js';
import { markMediaWrite } from '../../../../src/storage/mediaProtection.js';
// DOCX 正文抽取：共享纯函数（主进程只负责解 zip，见 electron/ipc/docx.js 的注释）。
import { extractDocxText } from '../../../../src/books/docxText.js';
import { Alert } from '../../platform/alert.js';
import { getBridge } from '../../platform/bridge.js';
import { documentDirectory } from '../../platform/fileSystem.js';
import { Button, Card, Row } from '../../settings/ui.jsx';
import RoleCommentPanel from './RoleCommentPanel.jsx';
import BookReader from './BookReader.jsx';
import BookshelfPanel from './BookshelfPanel.jsx';

// 把文件读成 base64：走既有 fs handle 通道（openHandle → readBytes → closeHandle），
// 避免为了 docx 再开一条「主进程读任意路径」的口子。
async function readUriAsBase64(uri) {
  const bridge = getBridge();
  const handle = await bridge.fs.openHandle(uri);
  const chunks = [];
  try {
    // readBytes 返回 Uint8Array；读到空块即结束（与共享层 fileSystem 的契约一致）。
    for (;;) {
      const chunk = await bridge.fs.readBytes(handle, 1024 * 1024);
      const bytes = chunk && chunk.bytes ? chunk.bytes : chunk;
      if (!bytes || bytes.length === 0) break;
      chunks.push(bytes);
      if (chunk && chunk.eof) break;
    }
  } finally {
    await bridge.fs.closeHandle(handle).catch(() => {});
  }
  let binary = '';
  for (const bytes of chunks) {
    for (let index = 0; index < bytes.length; index += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(index, index + 0x8000));
    }
  }
  return btoa(binary);
}

export default function BooksScreen({ palette, fonts }) {
  const { t } = useTranslation();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  // 书架筛选结果（null = 未选书架，显示全部）。
  const [shelfFilter, setShelfFilter] = useState(null);
  // 未选书架（null）或书架为空集时显示全部——与手机「全部」chip 同语义。
  const shownItems = useMemo(
    () => (Array.isArray(shelfFilter) && shelfFilter.length > 0 ? shelfFilter : items),
    [shelfFilter, items]
  );
  const [activeId, setActiveId] = useState('');
  // 阅读器当前章（由 BookReader 上报）：评论按这一章生成并锚定。
  const [readerChapter, setReaderChapter] = useState({ title: '', blockIndex: 0 });
  const [content, setContent] = useState(null);
  const [reading, setReading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await getBooks());
    } catch (error) {
      // 损坏不伪装成空库：保留当前列表并告知（与音乐库同一纪律）。
      Alert.alert(t('books.load.failed.title'), t('books.load.failed.body'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { load(); }, [load]);

  const activeBook = useMemo(
    () => items.find(item => item.id === activeId) || null,
    [items, activeId]
  );

  const openBook = async book => {
    if (!book || reading) return;
    setReading(true);
    try {
      const text = await readBookContent(book);
      setContent({ bookId: book.id, text: String(text || '') });
      setActiveId(book.id);
      // 进度只在真正打开时前移（手机同口径）：读到第一屏即视为已开始阅读。
      if (!book.progress || !book.progress.percent) {
        saveBookProgress(book.id, { percent: 1 }).catch(() => {});
      }
    } catch (error) {
      Alert.alert(t('books.open.failed.title'), t('books.open.failed.body'));
    } finally {
      setReading(false);
    }
  };

  const importFiles = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await getBridge().media.pick('text');
      const picked = result && !result.canceled && Array.isArray(result.items) ? result.items : [];
      for (const item of picked) {
        const ext = (String(item.uri || '').split('.').pop() || 'txt').toLowerCase();
        // 支持的格式：纯文本类 + DOCX。
        // DOCX 走主进程解 zip（node:zlib 只在主进程可用），取出正文后**存成 txt**——
        // 这样阅读器、分章、进度全部沿用既有路径，不需要为 docx 另开一条读链。
        const plain = ['txt', 'md', 'markdown', 'text'].includes(ext);
        if (!plain && ext !== 'docx') {
          Alert.alert(t('books.import.unsupported.title'), t('books.import.unsupported.body'));
          continue;
        }
        const id = `book-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const storedExt = plain ? ext : 'txt';
        const destination = `${documentDirectory}${BOOKS_DIR_NAME}/${id}.${storedExt}`;
        if (plain) {
          await getBridge().fs.copy(item.uri, destination);
        } else {
          // DOCX：经 fs handle 分块读字节（渲染层不传任意路径给主进程），
          // 拼成 base64 交给 books:docxText 解包。
          const base64 = await readUriAsBase64(item.uri);
          // 主进程只解 zip 拿 XML；正文抽取用共享纯函数（两端同一份判定）。
          const unpacked = await getBridge().books.docxXml(base64);
          const text = unpacked && unpacked.ok === true
            ? extractDocxText(unpacked.xml)
            : '';
          if (!text || !text.trim()) {
            Alert.alert(t('books.import.unsupported.title'), t('desktop.books.docxExtractFailed'));
            continue;
          }
          await getBridge().fs.write(destination, text, 'utf8');
        }
        markMediaWrite(destination);
        // 用共享层的 readBookContent 统计字符数（与手机同一口径），保证进度/分章一致。
        let chars = 0;
        try {
          const text = await readBookContent({ uri: destination });
          chars = String(text || '').length;
        } catch (error) {}
        await saveBookItem(normalizeBookItem({
          id,
          name: String(item.name || '').replace(/\.[^.]+$/, '') || id,
          uri: destination,
          size: Number(item.size) || 0,
          chars,
          addedAt: Date.now(),
          format: storedExt === 'md' || storedExt === 'markdown' ? 'markdown' : 'txt',
        }));
        getBridge().fs.delete(item.uri, true).catch(() => {});
      }
      await load();
    } catch (error) {
      Alert.alert(t('books.import.failed.title'), t('books.import.failed.body'));
    } finally {
      setBusy(false);
    }
  };

  const removeBook = book => {
    if (!book || busy) return;
    Alert.alert(t('common.delete'), book.name, [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: async () => {
          setBusy(true);
          try {
            await deleteBooks([book.id]);
            if (activeId === book.id) {
              setActiveId('');
              setContent(null);
            }
            await load();
          } catch (error) {
            Alert.alert(t('app.save.failed.title'), t('app.save.failed.body'));
          } finally {
            setBusy(false);
          }
        },
      },
    ]);
  };

  if (activeBook) {
    const readyText = content && content.bookId === activeBook.id ? content.text : '';
    // 正文还没加载完时先显示进度提示（BookReader 需要 text 才能切章）。
    if (!readyText) {
      return (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderBottom: `1px solid ${palette.divider}`, flex: 'none' }}>
            <Button label={t('common.back')} onClick={() => { setActiveId(''); setContent(null); }} palette={palette} fonts={fonts} />
            <strong style={{ fontSize: fonts.scaled(14) }}>{activeBook.name}</strong>
          </div>
          <div style={{ flex: 1, padding: 24, color: palette.textMuted, fontSize: fonts.scaled(12) }}>
            {reading ? t('backup.progress.ratio') : t('ext.home.books.desc')}
          </div>
        </div>
      );
    }
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {/* 分章阅读：切章/目录/进度都复用共享 blocks + chapterProgress（与手机同口径）。 */}
        <BookReader
          book={activeBook}
          text={readyText}
          palette={palette}
          fonts={fonts}
          onBack={() => { setActiveId(''); setContent(null); }}
          onChapterChange={setReaderChapter}
        />
        {/* 和角色一起读：让角色就当前的阅读内容说一句。 */}
        <div style={{ padding: '0 16px 16px', flex: 'none' }}>
          <RoleCommentPanel
            kind="books"
            target={activeBook}
            palette={palette}
            fonts={fonts}
            chapterTitle={readerChapter.title}
            chapterBlockIndex={readerChapter.blockIndex}
          />
        </div>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 16, minWidth: 0 }}>
      <Card title={t('ext.home.books')} hint={t('ext.home.books.desc')} palette={palette} fonts={fonts}>
        <Row>
          <Button
            label={busy ? t('backup.progress.ratio') : t('books.import')}
            onClick={importFiles}
            palette={palette}
            fonts={fonts}
            primary
            disabled={busy}
          />
          <Button
            label={loading ? t('backup.progress.ratio') : t('ext.home.books.summary', { count: items.length })}
            onClick={load}
            palette={palette}
            fonts={fonts}
            disabled={loading}
          />
        </Row>
      </Card>

      {/* 书架分组（共享 books/shelves.js）：选中书架时只显示其中的书。 */}
      <BookshelfPanel
        books={items}
        palette={palette}
        fonts={fonts}
        onFilterChange={setShelfFilter}
      />

      {shownItems.length === 0 && !loading ? (
        <Card palette={palette} fonts={fonts} title={t('books.empty.title')}>
          <div style={{ fontSize: fonts.scaled(12), color: palette.textMuted, lineHeight: 1.7 }}>
            {t('books.empty.body')}
          </div>
        </Card>
      ) : null}

      {shownItems.map(book => (
        <Card
          key={book.id}
          palette={palette}
          fonts={fonts}
          title={book.name || t('common.unnamedCharacter')}
          hint={t('books.list.chars', { count: book.chars || 0 })}
        >
          <Row>
            <Button label={t('books.title')} onClick={() => openBook(book)} palette={palette} fonts={fonts} primary disabled={busy} />
            <Button
              label={t('common.delete')}
              onClick={() => removeBook(book)}
              palette={palette}
              fonts={fonts}
              tone={palette.danger || '#ff5a5f'}
              disabled={busy}
            />
          </Row>
        </Card>
      ))}
    </div>
  );
}