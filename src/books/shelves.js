// 书架分组存储领域：委托通用集合存储工厂（见 ../storage/collectionStore.js）。
// 分组只保存书籍 id 引用；书籍被删除时由调用方调 purgeBooksFromShelves 清理引用
// （界面渲染也会按书库过滤，双保险不留幽灵条目）。

import { createCollectionStore } from '../storage/collectionStore.js';

export const BOOK_SHELVES_KEY = '@easychat2_book_shelves';
export const SHELF_NAME_MAX = 40;

const store = createCollectionStore({
  key: BOOK_SHELVES_KEY,
  idPrefix: 'shelf',
  nameMax: SHELF_NAME_MAX,
  itemField: 'bookIds',
  errorCodePrefix: 'shelf',
});

// 错误码而非文案：存储层不持有用户可见文本（i18n 防复发规则），界面按 code 决策并给本地化提示。
export const SHELF_ERROR = store.ERROR;
export const normalizeShelf = store.normalize;
export const getBookShelves = store.getAll;
export const createBookShelf = store.create;
export const renameBookShelf = store.rename;
export const deleteBookShelf = store.remove;
export const setBookInShelf = store.setIncluded;
export const purgeBooksFromShelves = store.purgeItems;
