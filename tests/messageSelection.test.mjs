import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  getContinuousTailPlan,
  getEditResendPlan,
  removeMessagesByIds,
  selectableMessageIds,
  toggleMessageSelection,
} from '../src/chat/messageSelection.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHAT_SCREEN_SOURCE = readFileSync(path.join(HERE, '..', 'src', 'ChatScreen.js'), 'utf8');
const SESSION_MESSAGES_SOURCE = readFileSync(path.join(HERE, '..', 'src', 'chat', 'useSessionMessages.js'), 'utf8');
const CHAT_TOP_BAR_SOURCE = readFileSync(path.join(HERE, '..', 'src', 'chat', 'ChatTopBar.js'), 'utf8');
const MESSAGE_LIST_SOURCE = readFileSync(path.join(HERE, '..', 'src', 'chat', 'MessageList.js'), 'utf8');

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
    MESSAGE_LIST_SOURCE.includes('onLongPress={!messageSelectionOpen ?'),
    false
  );
  assert.ok(MESSAGE_LIST_SOURCE.includes('onLongPress={() => {'));
  assert.ok(MESSAGE_LIST_SOURCE.includes('if (messageSelectionOpen) return;'));
});

test('多选顶栏提供全选/取消全选按钮并接线', () => {
  // 顶栏多选态包含「全选」，全选时切换为「取消全选」。
  // 文案已迁到 i18n 词条表（chat.topBar.selection.selectAll / unselectAll），
  // 断言随之改为锁定「按 allSelected 在两个词条间切换」这一行为，而不是中文字面量。
  assert.ok(
    CHAT_TOP_BAR_SOURCE.includes("allSelected ? t('chat.topBar.selection.unselectAll') : t('chat.topBar.selection.selectAll')"),
    '全选按钮文案应随 allSelected 在 selectAll/unselectAll 词条间切换'
  );
  assert.ok(
    CHAT_TOP_BAR_SOURCE.includes("allSelected ? t('chat.topBar.a11y.unselectAll') : t('chat.topBar.a11y.selectAll')"),
    '无障碍标签同样应随状态切换'
  );
  assert.ok(CHAT_TOP_BAR_SOURCE.includes('onToggleSelectAll'));
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
    attachments: [],
    messages: messages.slice(0, 2),
  });
  assert.equal(getEditResendPlan(messages, 'b'), null);
});

test('修改重发计划：图片消息改为回填附件（复用原文件、可重新发送）', () => {
  const list = [
    { id: 'a', role: 'user', text: '前言' },
    {
      id: 'img',
      role: 'user',
      kind: 'image',
      text: '',
      image: { uri: 'file:///documents/chat-images/x.jpg', mime: 'image/jpeg', name: 'x.jpg', width: 100, height: 200 },
    },
    { id: 'r', role: 'assistant', text: '回复' },
  ];
  const plan = getEditResendPlan(list, 'img');
  assert.equal(plan.text, '', '图片消息没有正文可回填');
  assert.equal(plan.attachments.length, 1);
  const [attachment] = plan.attachments;
  assert.equal(attachment.uri, 'file:///documents/chat-images/x.jpg', '必须复用原 URI，不重新落盘');
  assert.equal(attachment.kind, 'image');
  assert.equal(attachment.mime, 'image/jpeg');
  assert.equal(attachment.width, 100);
  assert.equal(attachment.height, 200);
  // size 由发送路径重新 stat 磁盘决定，这里不写可能过期的值
  assert.equal(attachment.size, 0);
  assert.equal(plan.messages.length, 1, '撤回该消息及其后续回复');
  // 表情包保留贴纸身份，回到附件后仍按表情包发送
  const stickerPlan = getEditResendPlan([
    { id: 's', role: 'user', kind: 'sticker', text: '', image: { uri: 'file:///s.png', stickerId: 'st-1', stickerName: '猫猫' } },
  ], 's');
  assert.equal(stickerPlan.attachments[0].kind, 'sticker');
  assert.equal(stickerPlan.attachments[0].stickerId, 'st-1');
  assert.equal(stickerPlan.attachments[0].stickerName, '猫猫');
  // 缺 uri 的图片消息无法回填，返回 null（不产生空附件）
  assert.equal(getEditResendPlan([{ id: 'image', role: 'user', image: {} }], 'image'), null);
  // 助手消息（含助手图片）不属于用户消息，不可撤回
  assert.equal(getEditResendPlan([{ id: 'ai', role: 'assistant', image: { uri: 'file:///a.png' } }], 'ai'), null);
});

test('主动消息刷新不清空输入/附件，也不打断进行中的请求', () => {
  // 加载 effect（已外提至 useSessionMessages）依赖含 messageRefreshTick：后台主动
  // 消息落库会推进它。会话未切换的 tick 刷新走独立分支，只把消息读回来，不做切
  // 会话的副作用。
  assert.ok(SESSION_MESSAGES_SOURCE.includes('const refreshTickRef = useRef(messageRefreshTick);'));
  assert.ok(SESSION_MESSAGES_SOURCE.includes('const tickChanged = refreshTickRef.current !== messageRefreshTick;'));
  assert.ok(SESSION_MESSAGES_SOURCE.includes('if (!sessionChanged && tickChanged && loadSessionId) {'));
  assert.ok(SESSION_MESSAGES_SOURCE.includes('if (sendLockRef.current || abortRef.current) return undefined;'));
  // tick 分支里不再有清空输入/删除草稿附件的调用
  const tickBranch = SESSION_MESSAGES_SOURCE.slice(
    SESSION_MESSAGES_SOURCE.indexOf('if (!sessionChanged && tickChanged && loadSessionId) {'),
    SESSION_MESSAGES_SOURCE.indexOf('refreshTickRef.current = messageRefreshTick;\n    if (draftSaveTimerRef.current)')
  );
  assert.ok(tickBranch.length > 0, '应能截取 tick 刷新分支');
  assert.equal(tickBranch.includes("setInput('')"), false);
  assert.equal(tickBranch.includes('deleteLocalImage'), false);
  assert.equal(tickBranch.includes('sendLockRef.current = null'), false);
});

test('MessageBubble 的引用/重选回调保持稳定引用以击穿 memo', () => {
  // onPressQuoteBlock 改为经 messagesRef 查询，不再依赖 messages 数组
  assert.ok(CHAT_SCREEN_SOURCE.includes('const exists = messagesRef.current.some(item => item.id === quote.id);'));
  // i18n 迁移后回调内引用 t()，依赖多了 t；核心约束不变：不依赖 messages 数组
  assert.ok(CHAT_SCREEN_SOURCE.includes('}, [scrollToMessage, t]);'));
  // openGreetingPicker 经 messagesRef 读取当前消息，不再依赖 messages
  assert.ok(CHAT_SCREEN_SOURCE.includes('const current = messagesRef.current.find(item => isGreetingMessage(item, activeSessionIdRef.current));'));
  // 渲染处不再内联箭头函数
  assert.equal(CHAT_SCREEN_SOURCE.includes("() => openGreetingPicker('reselect')"), false);
  assert.equal(CHAT_SCREEN_SOURCE.includes('() => startMessageSelection(message.id)'), false);
  assert.ok(MESSAGE_LIST_SOURCE.includes('onReselectGreeting={sessionOwnerMissing ? undefined : onReselectGreeting}'));
  assert.ok(MESSAGE_LIST_SOURCE.includes('onStartSelection={richInteractive ? startMessageSelection : undefined}'));
});

test('getContinuousTailPlan：连续到队尾的删除返回归档计划', () => {
  const messages = [
    { id: 'a', role: 'user', text: '1' },
    { id: 'b', role: 'assistant', text: '2' },
    { id: 'c', role: 'user', text: '3' },
  ];
  const plan = getContinuousTailPlan(messages, ['c']);
  assert.deepEqual(plan.kept.map(m => m.id), ['a', 'b']);
  assert.deepEqual(plan.tail.map(m => m.id), ['c']);
  assert.equal(plan.forkMessageId, 'b');

  const all = getContinuousTailPlan(messages, ['a', 'b', 'c']);
  assert.deepEqual(all.kept, []);
  assert.equal(all.forkMessageId, '');
});

test('getContinuousTailPlan：非连续或非队尾删除不建分支', () => {
  const messages = [
    { id: 'a', role: 'user', text: '1' },
    { id: 'b', role: 'assistant', text: '2' },
    { id: 'c', role: 'user', text: '3' },
  ];
  assert.equal(getContinuousTailPlan(messages, ['a']), null, '中间删除不算尾段');
  assert.equal(getContinuousTailPlan(messages, ['a', 'c']), null, '不连续');
  assert.equal(getContinuousTailPlan(messages, []), null);
  assert.equal(getContinuousTailPlan(messages, ['missing']), null);
});

test('撤回路径归档尾段：编辑重发/重新生成/连续尾段删除都先留分支', () => {
  const CHAT_SEND_SOURCE = readFileSync(path.join(HERE, '..', 'src', 'chat', 'useChatSend.js'), 'utf8');
  // 编辑重发：归档被丢弃尾段后再 setMessages
  assert.ok(CHAT_SEND_SOURCE.includes('const removedTail = latestMessages.slice(keptCount);'));
  assert.ok(CHAT_SEND_SOURCE.includes('await archiveActiveTail(sessionGuard.sessionId, removedForkId, removedTail);'));
  // 重新生成：捕获被重生成尾段并归档
  assert.ok(CHAT_SEND_SOURCE.includes('const removedTail = messages.slice(index);'));
  // 删除连续尾段：ChatScreen 走 getContinuousTailPlan 后归档
  assert.ok(CHAT_SCREEN_SOURCE.includes('const tailPlan = getContinuousTailPlan(messagesRef.current, ids);'));
  assert.ok(CHAT_SCREEN_SOURCE.includes('await archiveBranch(sessionId, tailPlan.forkMessageId, tailPlan.tail).catch(() => {});'));
});
