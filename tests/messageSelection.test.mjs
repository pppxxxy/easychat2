import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  getEditResendPlan,
  removeMessagesByIds,
  selectableMessageIds,
  toggleMessageSelection,
} from '../src/messageSelection.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHAT_SCREEN_SOURCE = readFileSync(path.join(HERE, '..', 'src', 'ChatScreen.js'), 'utf8');
const CHAT_TOP_BAR_SOURCE = readFileSync(path.join(HERE, '..', 'src', 'chat', 'ChatTopBar.js'), 'utf8');

test('消息选择支持添加、移除与重复选择', () => {
  assert.deepEqual(toggleMessageSelection([], 'a'), ['a']);
  assert.deepEqual(toggleMessageSelection(['a'], 'b'), ['a', 'b']);
  assert.deepEqual(toggleMessageSelection(['a', 'b'], 'a'), ['b']);
  assert.deepEqual(toggleMessageSelection(['a'], ''), ['a']);
});

test('批量删除只移除选中的消息并保持原顺序', () => {
  const messages = [
    { id: 'a', text: '第一条' },
    { id: 'b', text: '第二条' },
    { id: 'c', text: '第三条' },
  ];
  assert.deepEqual(removeMessagesByIds(messages, ['a', 'c']), [messages[1]]);
  assert.deepEqual(removeMessagesByIds(messages, []), messages);
  assert.equal(messages.length, 3);
});

test('全选候选排除生成中的占位消息与无 id 项', () => {
  const messages = [
    { id: 'a', text: '用户消息' },
    { id: 'p', pending: true, text: '生成中' },
    { id: 'b', text: '助手回复' },
    { text: '没有 id' },
    null,
  ];
  assert.deepEqual(selectableMessageIds(messages), ['a', 'b']);
  // 空/非法输入返回空数组，不抛异常
  assert.deepEqual(selectableMessageIds([]), []);
  assert.deepEqual(selectableMessageIds(null), []);
});

test('多选态消息 Pressable 的 onLongPress 始终非空（原地松手不退出多选）', () => {
  // 回归：长按进入多选后本轮会重渲染，若把 onLongPress 置为 undefined，松手时
  // RN Pressability 的 isPressCanceledByLongPress 判定失效，会补发 onPress 把刚
  // 选中的消息又取消，表现为「原地松手就变回原样，只有滑动才留得住多选」。
  // 因此渲染里不得出现 onLongPress={!messageSelectionOpen ? ... : undefined} 的写法。
  assert.equal(
    CHAT_SCREEN_SOURCE.includes('onLongPress={!messageSelectionOpen ?'),
    false
  );
  assert.ok(CHAT_SCREEN_SOURCE.includes('onLongPress={() => {'));
  assert.ok(CHAT_SCREEN_SOURCE.includes('if (messageSelectionOpen) return;'));
});

test('多选顶栏提供全选/取消全选按钮并接线', () => {
  // 顶栏多选态包含「全选」，全选时切换为「取消全选」
  assert.ok(CHAT_TOP_BAR_SOURCE.includes("allSelected ? '取消全选' : '全选'"));
  assert.ok(CHAT_TOP_BAR_SOURCE.includes('onToggleSelectAll'));
  assert.ok(CHAT_TOP_BAR_SOURCE.includes("accessibilityLabel={allSelected ? '取消全选' : '全选消息'}"));
  // ChatScreen 传入全选相关 props
  assert.ok(CHAT_SCREEN_SOURCE.includes('onToggleSelectAll={toggleSelectAllMessages}'));
  assert.ok(CHAT_SCREEN_SOURCE.includes('allSelected={allMessagesSelected}'));
});

test('移除输入区「清空」按钮，改由全选+删除承担清空', () => {
  const composer = readFileSync(
    path.join(HERE, '..', 'src', 'chat', 'ChatComposer.js'),
    'utf8'
  );
  assert.equal(composer.includes('清空'), false);
  assert.equal(composer.includes('onClear'), false);
  // ChatScreen 不再向下传 onClear / messagesCount
  assert.equal(CHAT_SCREEN_SOURCE.includes('onClear={onClear}'), false);
  // 删光全部消息时按清空收尾（重置开场白 + 清理整段向量索引）
  assert.ok(CHAT_SCREEN_SOURCE.includes('const clearsAll = messagesRef.current.length > 0 && messagesAfter.length === 0;'));
  assert.ok(CHAT_SCREEN_SOURCE.includes('removeVectorIndexForSession(vectorOwnerId, sessionId)'));
});

test('修改重发计划撤回目标消息及后续回复并回填文字', () => {
  const messages = [
    { id: 'a', role: 'user', text: '上一条消息' },
    { id: 'b', role: 'assistant', text: '上一轮回复' },
    { id: 'c', role: 'user', text: '当前消息' },
  ];
  assert.deepEqual(getEditResendPlan(messages, 'c'), {
    text: '当前消息',
    messages: messages.slice(0, 2),
  });
  assert.equal(getEditResendPlan(messages, 'b'), null);
  assert.equal(getEditResendPlan([{ id: 'image', role: 'user', image: {} }], 'image'), null);
});

test('主动消息刷新不清空输入/附件，也不打断进行中的请求', () => {
  // 加载 effect 依赖含 messageRefreshTick：后台主动消息落库会推进它。修复后
  // 会话未切换的 tick 刷新走独立分支，只把消息读回来，不做切会话的副作用。
  assert.ok(CHAT_SCREEN_SOURCE.includes('const refreshTickRef = useRef(messageRefreshTick);'));
  assert.ok(CHAT_SCREEN_SOURCE.includes('const tickChanged = refreshTickRef.current !== messageRefreshTick;'));
  assert.ok(CHAT_SCREEN_SOURCE.includes('if (!sessionChanged && tickChanged && loadSessionId) {'));
  assert.ok(CHAT_SCREEN_SOURCE.includes('if (sendLockRef.current || abortRef.current) return undefined;'));
  // tick 分支里不再有清空输入/删除草稿附件的调用
  const tickBranch = CHAT_SCREEN_SOURCE.slice(
    CHAT_SCREEN_SOURCE.indexOf('if (!sessionChanged && tickChanged && loadSessionId) {'),
    CHAT_SCREEN_SOURCE.indexOf('refreshTickRef.current = messageRefreshTick;\n      if (draftSaveTimerRef.current)')
  );
  assert.ok(tickBranch.length > 0, '应能截取 tick 刷新分支');
  assert.equal(tickBranch.includes("setInput('')"), false);
  assert.equal(tickBranch.includes('deleteLocalImage'), false);
  assert.equal(tickBranch.includes('sendLockRef.current = null'), false);
});

test('MessageBubble 的引用/重选回调保持稳定引用以击穿 memo', () => {
  // onPressQuoteBlock 改为经 messagesRef 查询，不再依赖 messages 数组
  assert.ok(CHAT_SCREEN_SOURCE.includes('const exists = messagesRef.current.some(item => item.id === quote.id);'));
  assert.ok(CHAT_SCREEN_SOURCE.includes('}, [scrollToMessage]);'));
  // openGreetingPicker 经 messagesRef 读取当前消息，不再依赖 messages
  assert.ok(CHAT_SCREEN_SOURCE.includes('const current = messagesRef.current.find(item => isGreetingMessage(item, activeSessionIdRef.current));'));
  // 渲染处不再内联箭头函数
  assert.equal(CHAT_SCREEN_SOURCE.includes("() => openGreetingPicker('reselect')"), false);
  assert.equal(CHAT_SCREEN_SOURCE.includes('() => startMessageSelection(message.id)'), false);
  assert.ok(CHAT_SCREEN_SOURCE.includes('onReselectGreeting={sessionOwnerMissing ? undefined : onReselectGreeting}'));
  assert.ok(CHAT_SCREEN_SOURCE.includes('onStartSelection={richInteractive ? startMessageSelection : undefined}'));
});
