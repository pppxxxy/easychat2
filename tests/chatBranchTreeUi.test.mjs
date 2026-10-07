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
const FORK_ROW = read('src/chat/BranchForkRow.js');
const USE_BRANCHES = read('src/chat/useChatBranches.js');
const ZH = read('src/i18n/locales/zh-CN/chat.js');
const EN = read('src/i18n/locales/en/chat.js');

test('分叉入口按分叉消息渲染，空分支不渲染', () => {
  assert.ok(MESSAGE_LIST.includes("import BranchForkRow from './BranchForkRow.js';"));
  assert.ok(MESSAGE_LIST.includes('const forkBranches = forkMap ? (forkMap.get(String(message.id || \'\')) || []) : [];'));
  assert.ok(MESSAGE_LIST.includes('forkBranches.length > 0 ? ('), '仅在存在分支时渲染入口');
  assert.ok(MESSAGE_LIST.includes('const rootBranches = forkMap ? (forkMap.get(\'\') || []) : [];'));
  // 入口挂在消息之后（两种返回分支都要带 forkRow）
  assert.equal(MESSAGE_LIST.match(/\{forkRow\}/g)?.length, 2, '富 HTML 与普通两条返回分支都要带分叉入口');
});

test('BranchForkRow：可展开 + 切换/删除回调 + 发送中禁用切换', () => {
  assert.ok(FORK_ROW.includes("useState(false)"), '有展开状态');
  assert.ok(FORK_ROW.includes('onCheckoutBranch'), '切换回调');
  assert.ok(FORK_ROW.includes('onDeleteBranch'), '删除回调');
  assert.ok(FORK_ROW.includes('checkoutDisabled'), '发送中禁用切换');
  assert.ok(FORK_ROW.includes("t('chat.branch.checkout')"));
  assert.ok(FORK_ROW.includes("t('chat.branch.delete')"));
  assert.ok(FORK_ROW.includes('count === 0) return null'), '空分支不渲染');
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
  ];
  keys.forEach(key => {
    assert.ok(ZH.includes(`'${key}'`), `zh-CN 缺 ${key}`);
    assert.ok(EN.includes(`'${key}'`), `en 缺 ${key}`);
  });
});
