// 桌面外壳结构守卫（S12 后半）：手机版有、桌面此前缺的四项能力。
//
// 这四项都属「界面缺失」而不是「能力缺失」——底层数据与判定早就在共享层里跑：
//   · 搜索：chat/chatSearchMath.js（命中 + 循环推进）；
//   · 统计：storage/sessionStats.js（每次请求都在落盘）＋ chat/sessionStats.js；
//   · 导出：chat/conversationExport.js（Markdown/HTML 生成与截断口径）；
//   · 记忆总结：memory/memorySummary.js（判定 + 落库 + 修订号校验）。
// 所以桌面这边只应该补「宿主接线与渲染」，**不得**另写一套判定——那会让两端口径漂移。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, '..');
const read = (...parts) => readFileSync(path.join(DESKTOP, ...parts), 'utf8');

const PANE = read('src', 'provider', 'ChatPane.jsx');
const CHAT = read('src', 'provider', 'useDesktopChat.js');
const SEARCH_HOOK = read('src', 'chat', 'useDesktopChatSearch.js');
const SEARCH_BAR = read('src', 'chat', 'ChatSearchBar.jsx');
const STATS = read('src', 'chat', 'SessionStatsPanel.jsx');
const EXPORT = read('src', 'chat', 'ConversationExportPanel.jsx');
const SUMMARY = read('src', 'chat', 'useDesktopMemorySummary.js');
const MORE_MENU = read('src', 'chat', 'ChatMoreMenu.jsx');
// S16 起消息行外提为 MessageList（ChatPane 撞 800 行棘轮）：锚点与高亮落在那里。
const MESSAGE_LIST = read('src', 'provider', 'MessageList.jsx');

test('对话内搜索复用共享层口径，不另写命中判定', () => {
  assert.ok(SEARCH_HOOK.includes("from '../../../src/chat/chatSearchMath.js'"), '未复用共享搜索逻辑');
  assert.ok(SEARCH_HOOK.includes('collectSearchMatchIds'), '缺命中集合');
  assert.ok(SEARCH_HOOK.includes('advanceMatchIndex'), '缺循环推进（自己算下标会与手机不一致）');
  // 命中判定绝不能在桌面重写：一条 includes 就够漂移。
  assert.equal(/\.toLowerCase\(\)\.includes\(/.test(SEARCH_HOOK), false, '不得在桌面重写匹配判定');
  // 关闭时短路（共享层的既有优化），由 open 参数传入。
  assert.ok(SEARCH_HOOK.includes('collectSearchMatchIds(messages, query, open)'), '未把 open 传进短路参数');
});

test('搜索界面：计数 / 上下条 / 关闭 / 高亮锚点都在', () => {
  assert.ok(SEARCH_BAR.includes("t('chat.search.placeholder')"), '缺占位文案');
  assert.ok(SEARCH_BAR.includes('matchCount ? `${activeMatchIndex + 1}/${matchCount}` : \'0/0\''), '缺命中计数');
  assert.ok(SEARCH_BAR.includes("t('chat.search.prevA11y')"), '缺上一条');
  assert.ok(SEARCH_BAR.includes("t('chat.search.nextA11y')"), '缺下一条');
  // 桌面是普通滚动容器：靠 data-message-id 锚点 + scrollIntoView（手机走 FlatList）。
  assert.ok(MESSAGE_LIST.includes('data-message-id'), '消息行缺搜索锚点');
  assert.ok(SEARCH_HOOK.includes('scrollIntoView'), '缺滚动跳转');
  assert.ok(SEARCH_HOOK.includes('data-message-id'), '滚动选择器与锚点不一致');
  // 当前命中要有可见高亮（否则用户不知道滚到了哪条）。
  assert.ok(MESSAGE_LIST.includes('focusedId'), '缺命中高亮');
});

test('本会话统计：读共享层落盘数据，展示口径与手机同源', () => {
  assert.ok(STATS.includes('getSessionStats'), '未读取会话统计');
  assert.ok(STATS.includes('summarizeStats'), '未复用共享层汇总');
  // 格式化函数必须来自共享模块（手机 SessionStatsModal 用的同一套）。
  for (const fn of ['formatLatency', 'formatPercent', 'formatSpeed', 'formatTokenCount']) {
    assert.ok(STATS.includes(fn), `缺格式化函数 ${fn}`);
  }
  assert.ok(STATS.includes("from '../../../src/chat/sessionStatsFormat.js'"), '格式化未从共享模块导入');
  // 无数据时如实说明，不显示一排 0。
  assert.ok(STATS.includes("t('chat.stats.empty')"), '缺「还没有请求记录」');
  // 用户可见口径说明（真实值 vs 估算）必须保留。
  assert.ok(STATS.includes("t('chat.stats.note')"), '缺口径说明');
  // 清空走共享存储（不清空就是只能进不能出）。
  assert.ok(STATS.includes('clearSessionStats'), '缺清空入口');
});

test('对话导出：复用共享导出模块，落盘后经系统另存为', () => {
  assert.ok(EXPORT.includes("from '../../../src/chat/conversationExport.js'"), '未复用共享导出逻辑');
  for (const fn of ['collectExportMessages', 'buildExportEntries', 'toMarkdown', 'toHtml', 'exportFileName']) {
    assert.ok(EXPORT.includes(fn), `缺 ${fn}`);
  }
  assert.ok(EXPORT.includes('writeChatExportText'), '未写出到缓存目录');
  // 桌面没有分享面板：走 backup:saveAs（主进程会校验源在 documents/cache 内）。
  assert.ok(EXPORT.includes('backup.saveAs'), '缺另存为');
  // meta 必须带 count/truncated/omitted，否则头信息会显示「共 0 条」。
  assert.ok(EXPORT.includes('count: entries.length'), 'meta 缺 count');
  assert.ok(EXPORT.includes('truncated: collected.truncated'), 'meta 缺 truncated');
  assert.ok(EXPORT.includes('omitted: collected.omitted'), 'meta 缺 omitted');
  // 空会话不得导出空文件。
  assert.ok(EXPORT.includes("t('chat.export.empty')"), '缺空态说明');
});

test('记忆总结：除手动入口外，自动链路也必须真的接到发送钩子上', () => {
  // 手动：走共享层 applySummary（含修订号校验与作用域复核）。
  assert.ok(SUMMARY.includes('applySummary'), '未复用共享总结落库');
  assert.ok(SUMMARY.includes('selectManualSummarizable'), '手动总结的选择口径未复用');
  // 自动：shouldSummarize + selectSummarizable（手机同一对判定）。
  assert.ok(SUMMARY.includes('shouldSummarize'), '缺自动总结触发判定');
  assert.ok(SUMMARY.includes('selectSummarizable'), '缺自动总结候选选择');
  // 同一条会话同一组候选只尝试一次（否则每轮都白烧一次 API）。
  assert.ok(SUMMARY.includes('attemptRef'), '缺去重，可能反复重试同一份总结');
  // 群聊不支持（与手机同一提示）。
  assert.ok(SUMMARY.includes("tRef.current('chat.summary.groupUnsupported.title')"), '缺群聊拦截');
  // 关键：hook 里的 no-op 必须已经换成真实转发，否则自动总结仍然是死的。
  assert.ok(
    CHAT.includes('autoSummarizeRef.current'),
    'useDesktopChat 的 maybeAutoSummarize 未转发到真实实现'
  );
  assert.equal(
    /const maybeAutoSummarize = useCallback\(async \(\) => \{\}, \[\]\)/.test(CHAT),
    false,
    'maybeAutoSummarize 仍是空实现（记忆系统会继续空转）'
  );
  assert.ok(PANE.includes('chat.autoSummarizeRef.current = summary.autoSummarize'), '面板未注入自动总结');
});

test('四项能力都有入口（否则功能等于不存在）', () => {
  assert.ok(PANE.includes('<ChatSearchBar'), '搜索条未渲染');
  assert.ok(PANE.includes('<SessionStatsPanel'), '统计面板未渲染');
  assert.ok(PANE.includes('<ConversationExportPanel'), '导出面板未渲染');
  assert.ok(PANE.includes('<ChatMoreMenu'), '更多菜单未渲染');
  // 「更多」菜单里四项都列出来（搜索/总结/统计/导出）。
  for (const key of ['chat.menu.search', 'chat.menu.summary', 'chat.menu.sessionStats', 'chat.menu.export']) {
    assert.ok(MORE_MENU.includes(key), `更多菜单缺 ${key}`);
  }
});

test('「更多」按钮有独立词条，不与消息气泡的 moreA11y 撞名', () => {
  // 真跑冒烟时踩过的坑：两者都叫「更多操作」时，探针/用户看到的两个同名按钮无法区分，
  // 探针先命中的是第一条消息气泡上的菜单（点开的是消息操作，不是会话菜单）。
  assert.ok(PANE.includes("t('chat.menu.more.a11y')"), '会话「更多」按钮未使用独立词条');
  assert.equal(
    /title=\{t\('chat\.bubble\.moreA11y'\)\}\s*\n?\s*disabled=\{!ready\}/.test(PANE),
    false,
    '会话「更多」按钮不应复用消息气泡的词条'
  );
});

test('桌面聊天面板仍有行数余量（不靠堆到 800 再拆）', () => {
  const lines = PANE.split('\n').length - (PANE.endsWith('\n') ? 1 : 0);
  assert.ok(lines <= 800, `ChatPane 已有 ${lines} 行，超过上限`);
});