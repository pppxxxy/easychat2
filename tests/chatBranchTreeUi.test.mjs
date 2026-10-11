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
