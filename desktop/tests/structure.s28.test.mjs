// 桌面外壳结构守卫（S28）：扩展页剩余六处的逐控件比对。
//
// 结论（除 agent 能力）：
//   · 世界地图 / 小游戏 / 日程：**零差异**（日程的预览文案走同一共享 preview）。
//   · 图像生成：缺 `seed`——共享 generateImage 早已支持，桌面没传，导致出图不可复现。
//   · 制卡工坊：缺 systemPrompt + 世界书 + 正则 + 预设四块编辑区。
//     生成/导入出来的高级内容原样留在草稿里（mergeDraft 不清），但用户看不到也改不了。
//   · 书籍阅读器：缺书架分组（共享 books/shelves.js 早已完整）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, '..');
const ROOT = path.resolve(DESKTOP, '..');
const read = (...parts) => readFileSync(path.join(DESKTOP, ...parts), 'utf8');
const readRoot = (...parts) => readFileSync(path.join(ROOT, ...parts), 'utf8');

const FORGE = read('src', 'extension', 'screens', 'CardForgeScreen.jsx');
const FORGE_ADV = read('src', 'extension', 'screens', 'ForgeAdvancedPanels.jsx');
const IMAGE_GEN = read('src', 'extension', 'screens', 'ImageGenScreen.jsx');
const BOOKS = read('src', 'extension', 'screens', 'BooksScreen.jsx');
const SHELF = read('src', 'extension', 'screens', 'BookshelfPanel.jsx');
const SCHEDULE = read('src', 'extension', 'screens', 'ScheduleScreen.jsx');
const MAP = read('src', 'extension', 'screens', 'MapScreen.jsx');
const GAMES = read('src', 'extension', 'screens', 'GamesScreen.jsx');

// ---------------------------------------------------------------------------
// 六处面 → 结论
// ---------------------------------------------------------------------------
const EXT_SURFACE = Object.freeze([
  { id: 'forge', status: 'ported', note: '补 systemPrompt/世界书/正则/预设' },
  { id: 'image', status: 'ported', note: '补 seed' },
  { id: 'map', status: 'done' },
  { id: 'games', status: 'done' },
  { id: 'schedule', status: 'done' },
  { id: 'books', status: 'ported', note: '补书架分组' },
]);

test('六处面都有明确归属，且桌面实现真实存在', () => {
  const sources = { forge: FORGE, image: IMAGE_GEN, map: MAP, games: GAMES, schedule: SCHEDULE, books: BOOKS };
  for (const item of EXT_SURFACE) {
    const source = sources[item.id];
    assert.ok(source && source.length > 500, `${item.id} 桌面实现像是空壳`);
  }
});

test('制卡工坊：四块高级编辑区都接上了共享构造器', () => {
  assert.ok(FORGE.includes('ForgeAdvancedPanels'), '制卡页未挂高级区块');
  assert.ok(FORGE_ADV.includes('forge.systemPrompt.label'), '缺 systemPrompt');
  // 世界书 / 正则 / 预设：构造与净化都走共享层，不自己拼默认值。
  assert.ok(FORGE_ADV.includes('createWorldEntry'), '世界书未用共享构造器');
  assert.ok(FORGE_ADV.includes('createRegexScript'), '正则未用共享构造器');
  assert.ok(FORGE_ADV.includes('makeCharacterPresetId'), '预设未用共享 id 生成');
  // 危险正则标记：与聊天引擎同一判据（引擎对它直接跳过，制卡端必须可见）。
  assert.ok(FORGE_ADV.includes('isUnsafeRegexPattern'), '缺危险正则标记');
  assert.ok(FORGE_ADV.includes('forge.regex.unsafeBadge'), '缺危险标记文案');
  // 世界书位置文案复用共享标签，不另造一份中文常量（会漂移且违反 i18n 规则）。
  assert.ok(FORGE_ADV.includes('WORLD_POSITION_LABELS'), '应复用共享位置标签');
  const shared = readRoot('src', 'character', 'cardParser', 'worldInfo.js');
  assert.ok(shared.includes('export const WORLD_POSITION_LABELS'), '共享层应导出位置标签');
});

test('图像生成：seed 传进 generateImage（可复现出图）', () => {
  assert.ok(/const \[seed, setSeed\]/.test(IMAGE_GEN), '缺 seed 状态');
  assert.ok(/seed:\s*\(\(\) =>/.test(IMAGE_GEN), '未把 seed 传给 generateImage');
  assert.ok(IMAGE_GEN.includes('imageGen.seedPlaceholder'), '缺 seed 输入框');
  // 空串必须映射成 undefined（服务端随机），不能变成 0 而固定成同一个种子。
  assert.ok(/if \(!value\) return undefined;/.test(IMAGE_GEN), '空 seed 应映射为 undefined');
  // 共享层确实支持 seed。
  const gen = readRoot('src', 'imageGen', 'index.js');
  assert.ok(/export async function generateImage\(\{[^}]*seed/.test(gen), '共享层应支持 seed');
});

test('书籍：书架分组走共享 shelves.js，并过滤幽灵条目', () => {
  assert.ok(SHELF.includes('getBookShelves'), '缺书架读取');
  assert.ok(SHELF.includes('createBookShelf'), '缺新建');
  assert.ok(SHELF.includes('deleteBookShelf'), '缺删除');
  assert.ok(SHELF.includes('setBookInShelf'), '缺把书加入书架');
  assert.ok(SHELF.includes('renameBookShelf'), '缺重命名');
  // 错误码必须用共享层的实际导出（collectionStore 只有 NAME_REQUIRED 等四项）。
  assert.ok(SHELF.includes('SHELF_ERROR.NAME_REQUIRED'), '应使用共享错误码');
  assert.ok(!/SHELF_ERROR\.(NAME_EMPTY|DUPLICATE)/.test(SHELF), '不得引用不存在的错误码');
  // 渲染时按现有书库过滤（书籍被删后不留幽灵条目）。
  assert.ok(/bookIds\.has/.test(SHELF), '应按现有书 id 过滤');
  assert.ok(BOOKS.includes('BookshelfPanel'), '书籍页未挂书架');
  assert.ok(BOOKS.includes('shownItems'), '未按书架筛选列表');
});

test('日程：预览走同一共享实现（不是各写一份）', () => {
  assert.ok(SCHEDULE.includes('schedulePreviewLines'), '缺预览');
  assert.ok(SCHEDULE.includes('currentPeriodText'), '缺当前时段');
  const shared = readRoot('src', 'extension', 'schedule', 'preview.js');
  assert.ok(shared.includes('export function schedulePreviewLines'), '共享层应提供预览');
  assert.ok(shared.includes('export function currentPeriodText'), '共享层应提供当前时段');
});

test('世界地图 / 小游戏：本页未发现功能缺口（留痕防重复核对）', () => {
  // 词条 diff 为空是当初的判断依据；这里至少钉住两页都真实渲染内容。
  assert.ok(MAP.includes('return (') && MAP.length > 2000, '地图页像空壳');
  assert.ok(GAMES.includes('return (') && GAMES.length > 1000, '游戏页像空壳');
  // 地图的「真实位置」设置属于世界观数据，走共享 worldMap 存储。
  assert.ok(/worldMap|getWorldMap|saveWorldMap/.test(MAP), '地图页应走共享存储');
});