// 对话树 UI 接线结构守卫（P3/P4）。项目无 React 渲染器，UI 层按既有约定
// 用源码锚点验证「组件/接线存在且约束成立」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = rel => readFileSync(path.join(HERE, '..', rel), 'utf8');

const CHAT_SCREEN = read('src/ChatScreen.js');
const MESSAGE_LIST = read('src/chat/MessageList.js');
const SWITCHER = read('src/chat/BranchSwitcher.js');
const USE_BRANCHES = read('src/chat/useChatBranches.js');
const ZH = read('src/i18n/locales/zh-CN/chat.js');
const EN = read('src/i18n/locales/en/chat.js');

test('版本切换器按「分叉点之后的第一条消息」渲染，空分支不渲染', () => {
  assert.ok(MESSAGE_LIST.includes("import { buildForkVersions } from './branchTree.js';"));
  assert.ok(MESSAGE_LIST.includes('const prevId = index > 0'), '分叉点取前一条消息');
  assert.ok(MESSAGE_LIST.includes('...buildForkVersions(forkBranches, message.timestamp)'));
  assert.ok(MESSAGE_LIST.includes('branchNav={branchNav}'), '把 nav 交给气泡渲染');
  // 不再用占位的分叉行
  assert.equal(MESSAGE_LIST.includes('BranchForkRow'), false, '旧分叉行已移除');
});

test('BranchSwitcher：紧凑 <N///M> + 前后箭头 + 到端置灰', () => {
  assert.ok(SWITCHER.includes('///'), '显示 当前///总数');
  assert.ok(SWITCHER.includes('prevDisabled'), '前一版禁用态');
  assert.ok(SWITCHER.includes('nextDisabled'), '后一版禁用态');
  assert.ok(SWITCHER.includes("t('chat.branch.prevA11y')"));
  assert.ok(SWITCHER.includes("t('chat.branch.nextA11y')"));
  assert.ok(SWITCHER.includes('Number(total) > 1'), '单版本不渲染');
});

test('回归：气泡的 React.memo 不得被内联箭头函数打穿（流式每个 tick 全窗口重渲）', () => {
  // 失效模式：MessageBubble 是 React.memo（MessageBubble.js:78），而宿主此前在 renderItem 里
  // 现算 `onBranchCheckout={branchId => onCheckoutBranch?.(forkBranches.find(...))}`——
  // 这个箭头每次渲染都是新引用，shallow compare 必然不等 ⇒ memo 对**每一条**已挂载消息
  // 恒失效。流式期间 ChatScreen 每个节流 tick 都重渲 ⇒ 窗口内约 80 条气泡整棵重渲。
  // 修法：宿主只传稳定引用（ChatScreen.js:1218 的 useCallback），分支查找搬进气泡内部
  // （气泡手里就有 branchNav.branches）。
  const BUBBLE = read('src/chat/MessageBubble.js');
  assert.ok(BUBBLE.includes('const MessageBubble = React.memo('), '气泡必须是 memo 组件（前提）');
  assert.equal(
    /onBranchCheckout=\{\s*branchId\s*=>/.test(MESSAGE_LIST),
    false,
    '宿主不得再给气泡传内联箭头（会把 memo 打穿）'
  );
  assert.ok(MESSAGE_LIST.includes('onBranchCheckout={onCheckoutBranch}'), '宿主只传稳定引用');
  assert.ok(BUBBLE.includes('checkoutBranchById'), '查找搬进气泡内部');
  assert.ok(
    BUBBLE.includes('Array.isArray(branchNav.branches)'),
    'branchNav.branches 是查找的数据源（MessageList 在这上面挂了 branches）'
  );
  assert.ok(BUBBLE.includes('onPrev={() => checkoutBranchById(branchNav.prevId)}'), '上一版走同一个查找');
  assert.ok(BUBBLE.includes('onNext={() => checkoutBranchById(branchNav.nextId)}'), '下一版走同一个查找');
});

test('回归：ErrorBubble 的三个死属性不得回来（它一个都不接）', () => {
  // ErrorBubble 的签名是 { message, rawError, onCopied, fullWidth, selectionMode, selected }
  // （ErrorBubble.js:12），内部也没有版本切换器。此前调用点传了 branchNav /
  // onBranchCheckout / onBranchDeleteOthers 三个它根本不读的属性（每个还会新建一个闭包）。
  const start = MESSAGE_LIST.indexOf('<ErrorBubble');
  assert.ok(start >= 0, '必须仍渲染 ErrorBubble');
  const block = MESSAGE_LIST.slice(start, MESSAGE_LIST.indexOf('/>', start));
  for (const dead of ['branchNav=', 'onBranchCheckout=', 'onBranchDeleteOthers=']) {
    assert.equal(block.includes(dead), false, `ErrorBubble 不该再收到 ${dead}`);
  }
  const ERROR_BUBBLE = read('src/chat/ErrorBubble.js');
  assert.ok(
    ERROR_BUBBLE.includes('{ message, rawError, onCopied, fullWidth, selectionMode, selected }'),
    'ErrorBubble 的签名即上一条判据（它确实不接这三个属性）'
  );
});

test('useChatBranches：切会话/刷新计数变化时重载，仅读索引', () => {
  assert.ok(USE_BRANCHES.includes('getBranchIndexStatus(sessionId)'), '只读轻量索引');
  assert.ok(USE_BRANCHES.includes('groupBranchesByFork(branches)'));
  assert.ok(USE_BRANCHES.includes('}, [reload, refreshToken]);'), 'refreshToken 变化触发重载');
  assert.ok(USE_BRANCHES.includes('sessionIdRef.current !== sessionId'), '异步回填防串会话');
});

test('ChatScreen：组装分支 hook 与切换/删除处理器', () => {
  assert.ok(CHAT_SCREEN.includes('useChatBranches({'));
  assert.ok(CHAT_SCREEN.includes('refreshToken: branchesRefreshToken'));
  assert.ok(CHAT_SCREEN.includes('const onCheckoutBranch = useCallback(async branch => {'));
  assert.ok(CHAT_SCREEN.includes('const onDeleteBranch = useCallback(async branch => {'));
  assert.ok(CHAT_SCREEN.includes('const plan = planCheckout(messagesRef.current, target);'));
  assert.ok(CHAT_SCREEN.includes('await archiveBranch(sessionId, plan.forkMessageId, plan.removedTail)'), '切换前归档被替换尾段');
  assert.ok(CHAT_SCREEN.includes('branchesByFork={ branchesByFork }'));
  assert.ok(CHAT_SCREEN.includes('onCheckoutBranch={ onCheckoutBranch }'));
  assert.ok(CHAT_SCREEN.includes('onDeleteBranch={ onDeleteBranch }'));
});

test('分支词条中英齐备', () => {
  const keys = [
    'chat.branch.forkEntry',
    'chat.branch.forkEntryRoot',
    'chat.branch.checkout',
    'chat.branch.delete',
    'chat.branch.countMeta',
    'chat.branch.stale.title',
    'chat.branch.checkoutFailed.title',
    'chat.branch.deleteFailed.title',
    'chat.branch.prevA11y',
    'chat.branch.nextA11y',
    'chat.branch.deleteOthers',
  ];
  keys.forEach(key => {
    assert.ok(ZH.includes(`'${key}'`), `zh-CN 缺 ${key}`);
    assert.ok(EN.includes(`'${key}'`), `en 缺 ${key}`);
  });
});
