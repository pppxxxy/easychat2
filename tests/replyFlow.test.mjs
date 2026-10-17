import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAutoSummaryInput,
  buildReplyErrorMessage,
  classifyReplyError,
  mergeErrorMessage,
  mergeStreamedReasoning,
  mergeStreamedText,
  planHistoryWindow,
  replacePendingWithReply,
  trimHistoryByBoundary,
  trimHistoryToRounds,
} from '../src/chat/replyFlow.js';
import { SYSTEM_ERROR_ID, USER_ID } from '../src/chat/chatConstants.js';
import { translate } from '../src/i18n/index.js';

// 真实翻译器（真语言包，非替身）：等价于渲染层注入的 t。
const t = (key, params) => translate('zh-CN', key, params);

const pending = id => ({
  id,
  role: 'assistant',
  text: '正在思考...',
  reasoning: '',
  pending: true,
  waitingForResponse: true,
});

test('trimHistoryByBoundary：boundary 之后为已发送原文，sentIds 与裁剪一致', () => {
  const history = [
    { id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' },
  ];
  const { trimmedHistory, sentIds } = trimHistoryByBoundary(history, 'b');
  assert.deepEqual(trimmedHistory.map(item => item.id), ['c', 'd']);
  assert.deepEqual([...sentIds].sort(), ['c', 'd']);
  // 无 boundary：全量保留
  const full = trimHistoryByBoundary(history, null);
  assert.equal(full.trimmedHistory.length, 4);
  assert.deepEqual([...full.sentIds].sort(), ['a', 'b', 'c', 'd']);
  // boundary 不在列表中：全量保留（findIndex 为 -1）
  const missing = trimHistoryByBoundary(history, 'zz');
  assert.equal(missing.trimmedHistory.length, 4);
  // 非数组入参兜底
  assert.deepEqual(trimHistoryByBoundary(null, 'b').trimmedHistory, []);
});

// 一轮 = 一条 user 消息及其后续回复（直到下一条 user 消息）。
const rounds = (count, repliesPerRound = 1) => {
  const list = [];
  for (let i = 0; i < count; i += 1) {
    list.push({ id: `u${i}`, role: USER_ID });
    for (let j = 0; j < repliesPerRound; j += 1) list.push({ id: `a${i}-${j}`, role: 'assistant' });
  }
  return list;
};

test('trimHistoryToRounds：从倒数第 N 条 user 消息处切，保留其后的全部回复', () => {
  const history = rounds(4, 2);
  const kept = trimHistoryToRounds(history, 2);
  assert.deepEqual(kept.map(item => item.id), ['u2', 'a2-0', 'a2-1', 'u3', 'a3-0', 'a3-1']);
  // 第 1 轮：只留最后一条 user 及其回复
  assert.deepEqual(trimHistoryToRounds(history, 1).map(item => item.id), ['u3', 'a3-0', 'a3-1']);
  // 轮数够多 / 恰好相等：原数组引用返回（不制造新数组）
  assert.strictEqual(trimHistoryToRounds(history, 4), history);
  assert.strictEqual(trimHistoryToRounds(history, 99), history);
});

test('trimHistoryToRounds：非法轮数与非数组入参原样返回', () => {
  const history = rounds(3);
  for (const bad of [0, -1, NaN, null, undefined, 'abc', {}]) {
    assert.strictEqual(trimHistoryToRounds(history, bad), history, `轮数 ${String(bad)} 不裁剪`);
  }
  assert.deepEqual(trimHistoryToRounds(null, 2), []);
  // 全是 assistant（例如只有问候语）：没有 user 锚点，不裁剪
  const greeting = [{ id: 'g', role: 'assistant' }];
  assert.strictEqual(trimHistoryToRounds(greeting, 2), greeting);
});

test('planHistoryWindow：总结开启（或读不到设置）时只按边界裁剪，行为不变', () => {
  const history = rounds(5);
  const on = planHistoryWindow({ historyMessages: history, boundary: null, memorySummary: { enabled: true, historyRounds: 2 } });
  assert.strictEqual(on.trimmedHistory, history, '开启态不按记忆长度裁剪');
  assert.equal(on.appliedRounds, 0);
  // 读设置失败 → 传 null：同样保持原状（发送内容不因一次存储读失败而改变）
  const fallback = planHistoryWindow({ historyMessages: history, boundary: null, memorySummary: null });
  assert.strictEqual(fallback.trimmedHistory, history);
  assert.equal(fallback.appliedRounds, 0);
});

test('planHistoryWindow：总结关闭时按记忆长度只留最近 N 轮，sentIds 随之收窄', () => {
  const history = rounds(5);
  const off = planHistoryWindow({
    historyMessages: history,
    boundary: null,
    memorySummary: { enabled: false, historyRounds: 2 },
  });
  assert.deepEqual(off.trimmedHistory.map(item => item.id), ['u3', 'a3-0', 'u4', 'a4-0']);
  assert.equal(off.appliedRounds, 2);
  // 被裁掉的老消息不再算「原文已发送」→ 可以重新走向量召回（否则关闭总结后会静默丢内容）
  assert.deepEqual([...off.sentIds].sort(), ['a3-0', 'a4-0', 'u3', 'u4']);
  // 轮数非法（0 / 缺失）：关闭态也不裁剪
  const bad = planHistoryWindow({ historyMessages: history, boundary: null, memorySummary: { enabled: false, historyRounds: 0 } });
  assert.strictEqual(bad.trimmedHistory, history);
  assert.equal(bad.appliedRounds, 0);
});

test('planHistoryWindow：先按摘要边界裁剪，再按记忆长度收窄（两步串联）', () => {
  const history = rounds(6);
  const planned = planHistoryWindow({
    historyMessages: history,
    boundary: 'u1',
    memorySummary: { enabled: false, historyRounds: 2 },
  });
  // 边界之后是 u2..u5（4 轮），再取最近 2 轮 → u4、u5
  assert.deepEqual(planned.trimmedHistory.map(item => item.id), ['u4', 'a4-0', 'u5', 'a5-0']);
  assert.equal(planned.appliedRounds, 2);
});

test('mergeStreamedText：只更新 pending 占位符并落地 waitingForResponse', () => {
  const p = pending('x');
  const other = { id: 'y', pending: true, text: 'old', waitingForResponse: true };
  const next = mergeStreamedText([other, p, { id: 'z', text: 'done', pending: false }], 'x', '第一段');
  assert.equal(next[0], other, '非目标消息原引用返回');
  assert.deepEqual(
    { ...next[1] },
    { id: 'x', role: 'assistant', text: '第一段', reasoning: '', pending: true, waitingForResponse: false }
  );
  // 已完成（非 pending）的消息不被改写
  assert.equal(next[2].text, 'done');
  // null 入参兜底
  assert.deepEqual(mergeStreamedText(null, 'x', 't'), []);
});

test('mergeStreamedText：文本未变时返回**同一数组引用**（流式每 token 不重渲染整表）', () => {
  const p = { id: 'x', role: 'assistant', text: '第一段', pending: true, waitingForResponse: false };
  const other = { id: 'y', text: 'old', pending: true, waitingForResponse: true };
  const list = [other, p];
  // 同一个 fullText 再来一次：必须原引用返回，否则上层 useMemo / React.memo 全部失效
  assert.strictEqual(mergeStreamedText(list, 'x', '第一段'), list);
  // 文本真的变了：新数组，且只有目标项换了对象
  const next = mergeStreamedText(list, 'x', '第一段更多');
  assert.notStrictEqual(next, list);
  assert.strictEqual(next[0], other, '非目标项保持原引用');
  assert.notStrictEqual(next[1], p);
  assert.equal(next[1].text, '第一段更多');
  // 未命中目标（id 不匹配 / 已结算非 pending）：同样原引用返回
  assert.strictEqual(mergeStreamedText(list, 'nope', 'x'), list);
  const settled = [{ id: 'x', text: 'done', pending: false }];
  assert.strictEqual(mergeStreamedText(settled, 'x', 'done'), settled);
  // 文本没变但 waitingForResponse 还没落地：仍要更新（否则占位态永远挂着）
  const stillWaiting = [{ id: 'x', text: 'same', pending: true, waitingForResponse: true }];
  const cleared = mergeStreamedText(stillWaiting, 'x', 'same');
  assert.notStrictEqual(cleared, stillWaiting);
  assert.equal(cleared[0].waitingForResponse, false);
});

test('mergeStreamedReasoning：不检查 pending，占位符期间持续覆写', () => {
  const p = pending('x');
  const next = mergeStreamedReasoning([p], 'x', '思考中……');
  assert.equal(next[0].reasoning, '思考中……');
  assert.equal(next[0].pending, true, 'reasoning 更新不改 pending');
  // 非 pending 的消息也能被 reasoning 更新（与原实现一致）
  const done = { id: 'd', reasoning: '', pending: false };
  assert.equal(mergeStreamedReasoning([done], 'd', 'r')[0].reasoning, 'r');
});

test('replacePendingWithReply：分段替换占位符；空回复落「没有收到回复。」', () => {
  const p = pending('x');
  const before = [{ id: 'u', text: 'hi' }, p, { id: 'a2', text: 'earlier' }];
  const parts = [
    { role: 'assistant', id: 'r1', text: '你好' },
    { role: 'assistant', id: 'r2', kind: 'sticker', text: '' },
  ];
  const next = replacePendingWithReply(before, 'x', parts, t);
  assert.equal(next.length, 4);
  assert.equal(next[1].id, 'r1');
  assert.equal(next[1].pending, false);
  assert.equal(next[1].waitingForResponse, false);
  assert.equal(next[2].id, 'r2');
  assert.equal(next[3].text, 'earlier');
  // 空回复
  const empty = replacePendingWithReply(before, 'x', [], t);
  assert.equal(empty[1].text, '没有收到回复。');
  assert.equal(empty[1].pending, false);
  // replyParts 非数组按空处理
  const nullParts = replacePendingWithReply(before, 'x', null, t);
  assert.equal(nullParts[1].text, '没有收到回复。');
  // 未命中占位符：仍返回新数组（保持原重渲染节奏），内容不变
  const miss = replacePendingWithReply(before, 'nope', parts, t);
  assert.notEqual(miss, before);
  assert.deepEqual(miss.map(i => i.id), before.map(i => i.id));
});

test('replacePendingWithReply：思考内容随分段保留（回归：完成后思考不再消失）', () => {
  // onReasoning 只覆写占位符的 reasoning，而 replyParts 是全新对象；
  // 不显式搬运，思考会在回复完成的瞬间丢失且未落盘（切换展示方式也找不回）。
  const base = { ...pending('x'), reasoning: '先分析问题\n再组织回答' };
  const parts = [
    { role: 'assistant', id: 'r1', text: '你好' },
    { role: 'assistant', id: 'r2', kind: 'sticker', text: '' },
  ];
  const next = replacePendingWithReply([base], 'x', parts, t);
  assert.equal(next[0].reasoning, '先分析问题\n再组织回答', '正文分段应带上思考内容');
  assert.equal(next[1].reasoning, undefined, '仅正文分段携带，媒体分段不带');
  // 纯媒体回复（无正文分段）：思考挂首个分段，不能丢
  const mediaOnly = replacePendingWithReply([base], 'x', [{ role: 'assistant', id: 'r1', kind: 'sticker', text: '' }], t);
  assert.equal(mediaOnly[0].reasoning, '先分析问题\n再组织回答');
  // 思考为空/纯空白：不注入字段，保持原有形状
  const noReasoning = replacePendingWithReply([{ ...pending('x'), reasoning: '' }], 'x', parts, t);
  assert.equal(noReasoning[0].reasoning, undefined);
  const blankReasoning = replacePendingWithReply([{ ...pending('x'), reasoning: '   ' }], 'x', parts, t);
  assert.equal(blankReasoning[0].reasoning, undefined);
  // 无正文且思考为空回复：走「没有收到回复。」分支，思考仍随该条保留
  const fallback = replacePendingWithReply([base], 'x', [], t);
  assert.equal(fallback[0].text, '没有收到回复。');
  assert.equal(fallback[0].reasoning, '先分析问题\n再组织回答');
});

test('classifyReplyError：配置变更 / 取消 / 真失败 三分类（判定器注入）', () => {
  // 判定器由调用方注入（api.js 的实现依据 message 常量 / canceled / AbortError），
  // 这里以内联等价实现验证分类路由本身。
  const isConfigChangedError = error => !!error && error.message === '模型来源已切换，请重新发送';
  const isCanceledError = error => !!error && (error.canceled === true || error.name === 'AbortError');
  assert.equal(classifyReplyError({ message: '模型来源已切换，请重新发送' }, isConfigChangedError, isCanceledError), 'config-changed');
  assert.equal(classifyReplyError({ canceled: true }, isConfigChangedError, isCanceledError), 'canceled');
  assert.equal(classifyReplyError({ name: 'AbortError' }, isConfigChangedError, isCanceledError), 'canceled');
  assert.equal(classifyReplyError(new Error('普通错误'), isConfigChangedError, isCanceledError), 'failure');
  assert.equal(classifyReplyError(null, isConfigChangedError, isCanceledError), 'failure');
  // 未注入判定器时按真失败处理（防御）
  assert.equal(classifyReplyError({ canceled: true }), 'failure');
});

test('buildReplyErrorMessage：气泡 id/role/脱敏 detail 与 rawText 透传', () => {
  const err = new Error('密钥 sk-abc1234567890 已泄露');
  const { message, rawText } = buildReplyErrorMessage('p1', err, t);
  assert.equal(message.id, 'p1-error');
  assert.equal(message.role, SYSTEM_ERROR_ID);
  assert.equal(message.text, '请求失败，点击查看详情');
  assert.ok(typeof message.timestamp === 'number');
  // rawText 是未脱敏原文，detail 是脱敏产物（可能等值，但必须是字符串）
  assert.ok(typeof rawText === 'string');
  assert.ok(typeof message.detail === 'string');
});

test('mergeErrorMessage：有部分内容则追加，否则整条替换', () => {
  const p = pending('x');
  const errBubble = { id: 'x-error', role: 'system_error', text: '请求失败，点击查看详情' };
  // 占位符仍被 settle 保留（有部分正文）→ 追加
  const partial = [{ id: 'u' }, { ...p, text: '已经生成的一半', waitingForResponse: false }];
  const appended = mergeErrorMessage(partial, 'x', errBubble, t);
  assert.equal(appended.length, 3);
  assert.equal(appended[1].id, 'x');
  assert.equal(appended[1].pending, false);
  assert.equal(appended[2].id, 'x-error');
  // 占位符无内容（settle 后被移除）→ 整条替换
  const bare = [{ id: 'u' }, p];
  const replaced = mergeErrorMessage(bare, 'x', errBubble, t);
  assert.equal(replaced.length, 2);
  assert.equal(replaced[1].id, 'x-error');
  assert.equal(replaced[1].role, 'system_error');
});

test('mergeErrorMessage：任何分支都必须返回**新数组**（MessageList 的 memo 靠这条不变量）', () => {
  // 为什么这条不能少：MessageList 现在是 React.memo（见 src/chat/MessageList.js 头部），
  // 它只在 props 变化时重渲染；而错误气泡的原文（rawError）走 errorRawRef 这个**ref**
  // 传递、ref 本身不会让 memo 失效。之所以仍然安全，是因为每次写 errorRawRef 都紧跟着
  // 一次 setMessages，而这条不变量保证那次 setMessages 必然换掉数组引用 ⇒ 列表必然重渲染。
  // 一旦哪天有人「顺手」让本函数在无事可做时 return 原数组，错误气泡就会静默不更新
  // （界面看着正常，只是报错详情永远出不来）——所以把它钉死在这里。
  const p = pending('x');
  const errBubble = { id: 'x-error', role: 'system_error', text: '请求失败' };
  const partial = [{ id: 'u' }, { ...p, text: '一半', waitingForResponse: false }];
  const bare = [{ id: 'u' }, p];
  for (const input of [partial, bare]) {
    const out = mergeErrorMessage(input, 'x', errBubble, t);
    assert.notEqual(out, input, '必须返回新数组（同引用会让 memo 跳过错误气泡更新）');
  }
  // 连「x 根本不在列表里」这种空转也要换引用：否则同一批写入里有一条走空转分支就漏更新。
  const unrelated = [{ id: 'u' }, { id: 'other' }];
  assert.notEqual(mergeErrorMessage(unrelated, 'x', errBubble, t), unrelated);
});

test('buildAutoSummaryInput：空回复以「没有收到回复。」参与摘要', () => {
  const p = pending('x');
  const base = [{ id: 'u', text: 'hi' }];
  const withParts = buildAutoSummaryInput(base, [{ role: 'assistant', id: 'r1', text: '答' }], p);
  assert.deepEqual(withParts.map(i => i.id), ['u', 'r1']);
  const withEmpty = buildAutoSummaryInput(base, [], p);
  assert.equal(withEmpty[1].text, '没有收到回复。');
  assert.equal(withEmpty[1].pending, false);
});
