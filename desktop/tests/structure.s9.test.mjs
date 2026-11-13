// 桌面外壳结构守卫（S9）：
//   · 顶栏「记忆」与「会话」是两个不同入口，不能再共用一个词条——那是 S8 遗留的
//     重名缺陷（两个按钮都显示「记忆」）；
//   · 角色页默认进角色库网格，编辑页必须有回库入口，否则用户进去就出不来；
//   · 聊天页的占用条与分支切换器接线存在（纯渲染层，Node 里没有 React 渲染器，
//     按本仓库既有约定用源码锚点验证）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, '..');
const ROOT = path.resolve(DESKTOP, '..');
const read = (...parts) => readFileSync(path.join(...parts), 'utf8');

const APP = read(DESKTOP, 'src', 'provider', 'DesktopApp.jsx');
const PANE = read(DESKTOP, 'src', 'provider', 'ChatPane.jsx');
const EDIT = read(DESKTOP, 'src', 'character', 'CharacterEditScreen.jsx');
const LIBRARY = read(DESKTOP, 'src', 'character', 'CharacterLibraryScreen.jsx');
const USAGE_BAR = read(DESKTOP, 'src', 'chat', 'ContextUsageBar.jsx');
const SWITCHER = read(DESKTOP, 'src', 'chat', 'BranchSwitcher.jsx');
const ZH_APP = read(ROOT, 'src', 'i18n', 'locales', 'zh-CN', 'app.js');
const EN_APP = read(ROOT, 'src', 'i18n', 'locales', 'en', 'app.js');

test('会话列表用独立词条：顶栏不再出现两个「记忆」', () => {
  assert.ok(ZH_APP.includes("'app.tab.sessions': '会话'"), '中文词条缺失');
  assert.ok(EN_APP.includes("'app.tab.sessions': 'Sessions'"), '英文词条缺失');
  // S10 起顶栏拓扑按手机版收敛：会话列表就是「记忆」标签本身，
  // 因此独立「会话」按钮已移除（拓扑改由 structure.s10 钉住）。
  assert.equal(APP.includes("t('app.tab.sessions')"), false, '顶栏不应再出现独立「会话」按钮');
  // 词条本身保留：其他位置（如未来入口）仍可用；重复的「记忆」不会因两处共用而出现。
  assert.ok(ZH_APP.includes("'app.tab.memory': '记忆'"));
});

test('角色页默认进角色库，编辑页带返回入口', () => {
  assert.ok(APP.includes("const [characterScreen, setCharacterScreen] = useState('library')"));
  assert.ok(APP.includes('<CharacterLibraryScreen'), '角色库未接线');
  assert.ok(APP.includes('onBack={() => setCharacterScreen(\'library\')}'), '编辑页没有回库回调');
  assert.ok(EDIT.includes('onBack'), '编辑页未接收回库回调');
  assert.ok(EDIT.includes("t('character.detail.back')"), '编辑页没有返回按钮');
  // 库里点「编辑」必须切到编辑页，点「切换到角色」必须回聊天页。
  // 切屏动作由宿主注入（库页只调 onEdit/onOpen），所以断言在 DesktopApp 一侧。
  assert.ok(LIBRARY.includes('onEdit('), '卡片没有编辑入口');
  assert.ok(APP.includes("setCharacterScreen('edit')"), '编辑入口未切屏');
  assert.ok(APP.includes("setView('chat')"), '打开角色未回聊天页');
});

test('角色库卡片：搜索/新建/导入/导出/删除入口齐全', () => {
  for (const marker of [
    "t('character.library.searchPlaceholder')",
    "t('character.library.new')",
    "t('backup.card.import')",
    "t('backup.card.exportJson')",
    "t('common.delete')",
    'filterCharacters',
    'sortCharacters',
  ]) {
    assert.ok(LIBRARY.includes(marker), `角色库缺 ${marker}`);
  }
});

test('每个角色首次成为当前角色时补开场白会话（不能只做一次）', () => {
  // 回归：原先 ensuredRef 是**一次性**锁，新建角色或切到没有会话的角色后聊天页永远空着。
  assert.ok(APP.includes('ensuredCharacterRef'), '缺少按角色 id 的记账');
  assert.equal(APP.includes('const ensuredRef = useRef(false)'), false, '一次性锁已移除');
  assert.ok(
    APP.includes('ensuredCharacterRef.current === activeId'),
    '必须按 activeId 判重，否则切角色不会补会话'
  );
  assert.ok(APP.includes('ensuredCharacterRef.current = \'\''), '建会话失败要允许下次重试');
  assert.ok(APP.includes("ensureCharacterSession(activeId).catch"), '补建会话的调用不存在');
});

test('侧栏「+」新建角色后直接进编辑页', () => {
  assert.ok(
    APP.includes("run('add', () => addCharacter(DEFAULT_NEW_CHARACTER))")
      && APP.includes("setCharacterScreen('edit')"),
    '新建角色后没有进编辑页'
  );
});

test('聊天页接线：占用条 + 分支切换器 + 压缩入口都存在', () => {
  assert.ok(PANE.includes('<ContextUsageBar'), '占用条未挂载');
  // S16 起分支切换器在 MessageList 里（消息行外提，ChatPane 撞 800 行棘轮）。
  assert.ok(
    PANE.includes('<MessageList') && read(DESKTOP, 'src', 'provider', 'MessageList.jsx').includes('<BranchSwitcher'),
    '分支切换器未挂载'
  );
  assert.ok(PANE.includes('useDesktopContextUsage'), '占用计算未接线');
  assert.ok(PANE.includes('useDesktopBranches'), '分支切换未接线');
  assert.ok(PANE.includes('useDesktopCompaction'), '压缩入口未接线');
  assert.ok(PANE.includes('buildBranchNav'), '分支导航未计算');
  // 占用条：「压缩」只在过线时出现（判定来自 usageView，不在这里另写比例）。
  assert.ok(USAGE_BAR.includes('shouldShowCompactHint'), '占用条自行判定是否提示');
  assert.ok(USAGE_BAR.includes("t('chat.compact.action')"));
  // 切换器：单版本不渲染，首尾箭头置灰。
  assert.ok(SWITCHER.includes('Number(nav.total) > 1'));
  assert.ok(SWITCHER.includes('prevDisabled'));
  assert.ok(SWITCHER.includes('nextDisabled'));
});