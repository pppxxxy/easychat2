// 书架（桌面）：把书籍分组，按书架筛选。复用共享 books/shelves.js。
//
// 这一块此前在桌面**整块缺失**——共享层早就有完整实现（createCollectionStore 派生：
// getAll / create / rename / remove / setIncluded / purgeItems），手机 BookScreen 有
// 完整 UI，桌面连书架概念都没露出来。
//
// 存储层只保存书籍 id 引用（不复制书本身）。书籍被删时由调用方调
// purgeBooksFromShelves 清理引用；本组件渲染时也按现有书库过滤一次，双保险不留幽灵条目。
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useTranslation } from '../../../../src/i18n/I18nContext.js';
import {
  createBookShelf,
  deleteBookShelf,
  getBookShelves,
  renameBookShelf,
  setBookInShelf,
  SHELF_ERROR,
  SHELF_NAME_MAX,
} from '../../../../src/books/shelves.js';
import { Alert } from '../../platform/alert.js';
import { Button, Card, Field, Row, Select, TextInput } from '../../settings/ui.jsx';

export default function BookshelfPanel({ books, palette, fonts, onFilterChange }) {
  const { t } = useTranslation();
  const [shelves, setShelves] = useState([]);
  const [activeId, setActiveId] = useState('');
  const [nameDraft, setNameDraft] = useState('');
  const [editingId, setEditingId] = useState('');
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      const list = await getBookShelves();
      setShelves(Array.isArray(list) ? list : []);
    } catch (error) {
      // 读失败按空处理但保留提示；书架是分组功能，读坏不该阻断阅读。
      setShelves([]);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  // 现有书籍 id 集合：用于过滤掉已被删除的书留下的引用（幽灵条目）。
  const bookIds = useMemo(
    () => new Set((Array.isArray(books) ? books : []).map(item => String(item.id))),
    [books]
  );

  const active = shelves.find(item => String(item.id) === String(activeId)) || null;
  const filtered = useMemo(() => {
    if (!active) return null;
    const ids = new Set((active.bookIds || []).map(String).filter(id => bookIds.has(id)));
    return (Array.isArray(books) ? books : []).filter(item => ids.has(String(item.id)));
  }, [active, bookIds, books]);

  useEffect(() => {
    if (typeof onFilterChange === 'function') onFilterChange(filtered);
  }, [filtered, onFilterChange]);

  // 错误码取自共享层（collectionStore 的 ERROR）。注意它只有
  // NAME_REQUIRED / NOT_FOUND / READ_FAILED / TARGET_INVALID —— 没有重名码，
  // 所以「名称重复」只能靠 save 抛出的 message 兜底，不能凭一个不存在的 code 判断。
  const failText = error => {
    const code = error && error.code;
    if (code === SHELF_ERROR.NAME_REQUIRED) return t('books.shelves.nameEmpty');
    if (code === SHELF_ERROR.READ_FAILED) return t('common.error.storageOrPermission');
    return String((error && error.message) || t('common.error.storageOrPermission'));
  };

  const submit = async () => {
    const name = String(nameDraft || '').trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      if (editingId) await renameBookShelf(editingId, name);
      else await createBookShelf(name);
      await reload();
      setNameDraft('');
      setEditingId('');
    } catch (error) {
      Alert.alert(t('books.shelves.create.title'), failText(error));
    } finally {
      setBusy(false);
    }
  };

  const shelfOptions = [
    { value: '', label: t('books.shelves.all') },
    ...shelves.map(item => ({
      value: String(item.id),
      label: t('books.shelves.chip', {
        name: item.name || t('books.shelves.namePlaceholder'),
        count: (item.bookIds || []).filter(id => bookIds.has(String(id))).length,
      }),
    })),
  ];

  return (
    <Card title={t('books.shelves.all')} palette={palette} fonts={fonts}>
      {shelves.length === 0 ? (
        <div style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>{t('books.shelves.empty')}</div>
      ) : (
        <>
          <Field label={t('books.shelves.all')} palette={palette} fonts={fonts}>
            <Select
              value={String(activeId || '')}
              options={shelfOptions}
              onChange={setActiveId}
              palette={palette}
              fonts={fonts}
            />
          </Field>
          {active ? (
            <Row>
              {filtered && filtered.length === 0 ? (
                <div style={{ fontSize: fonts.scaled(10), color: palette.textFaint, lineHeight: 1.6 }}>
                  {t('books.shelves.filterEmpty.body')}
                </div>
              ) : null}
              <Button
                label={t('books.shelves.delete')}
                onClick={() => {
                  Alert.alert(t('books.shelves.delete.title'), t('books.shelves.delete.body', { name: active.name || '' }), [
                    { text: t('common.cancel'), style: 'cancel' },
                    {
                      text: t('common.delete'),
                      style: 'destructive',
                      onPress: async () => {
                        try {
                          await deleteBookShelf(active.id);
                          setActiveId('');
                          await reload();
                        } catch (error) {
                          Alert.alert(t('books.shelves.delete.title'), failText(error));
                        }
                      },
                    },
                  ]);
                }}
                palette={palette}
                fonts={fonts}
                disabled={busy}
              />
            </Row>
          ) : null}
        </>
      )}

      <Row>
        <div style={{ flex: 1, minWidth: 140 }}>
          <TextInput
            value={nameDraft}
            onChange={setNameDraft}
            placeholder={t('books.shelves.namePlaceholder')}
            palette={palette}
            fonts={fonts}
            maxLength={SHELF_NAME_MAX}
          />
        </div>
        <Button
          label={editingId ? t('common.save') : t('books.shelves.create')}
          onClick={submit}
          palette={palette}
          fonts={fonts}
          primary
          disabled={busy || !String(nameDraft || '').trim()}
        />
      </Row>

      {/* 把书加入当前书架：选中书架后才有意义（「全部」不是一个可写入的书架）。 */}
      {active ? (
        <Field label={t('books.shelves.chip', { name: active.name || '', count: (active.bookIds || []).length })} palette={palette} fonts={fonts}>
          <Select
            value=""
            options={[
              { value: '', label: t('books.shelves.namePlaceholder') },
              ...(Array.isArray(books) ? books : []).map(item => ({
                value: String(item.id),
                label: item.name || t('books.shelves.namePlaceholder'),
              })),
            ]}
            onChange={async value => {
              if (!value) return;
              try {
                const included = (active.bookIds || []).map(String).includes(String(value));
                await setBookInShelf(active.id, String(value), !included);
                await reload();
              } catch (error) {
                Alert.alert(t('books.shelves.create.title'), failText(error));
              }
            }}
            palette={palette}
            fonts={fonts}
            disabled={busy}
          />
        </Field>
      ) : null}

      {shelves.length > 0 ? (
        <Row>
          {shelves.map(item => (
            <Button
              key={item.id}
              label={t('books.shelves.chip', {
                name: item.name || t('books.shelves.namePlaceholder'),
                count: (item.bookIds || []).filter(id => bookIds.has(String(id))).length,
              })}
              onClick={() => {
                // 点第二个书架名进入重命名草稿；点第一次只是切换到该书架。
                if (String(activeId) === String(item.id)) {
                  setEditingId(String(item.id));
                  setNameDraft(String(item.name || ''));
                  return;
                }
                setActiveId(String(item.id));
              }}
              palette={palette}
              fonts={fonts}
            />
          ))}
        </Row>
      ) : null}
    </Card>
  );
}