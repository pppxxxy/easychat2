// 统一计量器（messageMetrics）：三口径一次扫描，且与既有实现逐字节等价。
//
// 为什么需要这个模块：仓库里此前有三套体积口径各自实现——
//   ① JSON.stringify(整数组).length            （compaction 全量）
//   ② Σ JSON.stringify(每条) + (n-1) 逗号      （compaction 增量，比 ① 少数组括号 2 字节）
//   ③ Σ(4 + 内容 token)                       （tokenEstimate）
// ①②的差异**只在注释里约定**，2026-10-17 就因此踩过「单参误用导致体积恒为 0」的静默失效。
// 本模块把差异变成显式常量 ARRAY_BRACKET_BYTES，并把三口径收敛到一次逐条扫描。
//
// 本文件的判据是**等价性**：新实现算出的每个数必须与旧实现逐字节相同，一个字节都不许漂。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ARRAY_BRACKET_BYTES,
  bytesArrayOf,
  bytesJsonOf,
  messageMetrics,
  messagesMetrics,
} from '../src/chat/messageMetrics.js';
import { estimateMessagesBytes, createMessageBytesEstimator } from '../src/chat/compaction.js';
import { estimateMessagesTokens } from '../src/localModel/tokenEstimate.js';

const mkMessages = (n, avgChars) => Array.from({ length: n }, (_, i) => {
  let text = '';
  while (text.length < avgChars) text += '今天天气不错，我们出去走走吧。hello world ';
  return { id: `m${i}`, role: i % 2 ? 'assistant' : 'user', text: text.slice(0, avgChars), timestamp: 1700000000000 + i };
});

test('ARRAY_BRACKET_BYTES 是显式常量：全量与增量口径的差额就是它', () => {
  // 这条把「注释里的约定」变成可断言的数字。2 = `[` + `]`。
  assert.equal(ARRAY_BRACKET_BYTES, 2);
  for (const [n, avg] of [[1, 10], [2, 50], [50, 300], [500, 120]]) {
    const list = mkMessages(n, avg);
    assert.equal(
      bytesArrayOf(list) - bytesJsonOf(list),
      ARRAY_BRACKET_BYTES,
      `n=${n}：全量口径必须恰好比增量口径多 ${ARRAY_BRACKET_BYTES} 字节（数组括号）`
    );
  }
});

test('全量口径与 JSON.stringify(数组).length 逐字节相等', () => {
  for (const [n, avg] of [[0, 0], [1, 10], [2, 50], [50, 300], [1000, 300]]) {
    const list = mkMessages(n, avg);
    assert.equal(bytesArrayOf(list), JSON.stringify(list).length, `n=${n} 全量口径漂了`);
    assert.equal(estimateMessagesBytes(list), JSON.stringify(list).length, `n=${n} compaction 全量入口漂了`);
  }
});

test('增量口径与 createMessageBytesEstimator 逐字节相等（Σ逐条 + 逗号，不含括号）', () => {
  for (const [n, avg] of [[0, 0], [1, 10], [2, 50], [50, 300], [1000, 300]]) {
    const list = mkMessages(n, avg);
    const legacy = createMessageBytesEstimator()(list);
    assert.equal(bytesJsonOf(list), legacy, `n=${n} 增量口径漂了（旧 ${legacy} / 新 ${bytesJsonOf(list)}）`);
    // 手工核对：Σ逐条 + (n-1) 逗号
    const sum = list.reduce((acc, item) => acc + JSON.stringify(item).length, 0);
    assert.equal(bytesJsonOf(list), sum + (list.length > 1 ? list.length - 1 : 0), `n=${n} 增量口径算式漂了`);
  }
});

test('token 口径与 tokenEstimate 逐字节相等（含 text→content 的适配）', () => {
  // 关键：estimateMessageTokens 读 message.content，而聊天消息正文在 message.text。
  // messagesMetrics 必须做与 contextUsage.estimateHistoryTokens 相同的适配，
  // 否则会算出「只有 overhead、正文 0 token」的错数（实测差 10 倍）。
  for (const [n, avg] of [[0, 0], [1, 10], [50, 300], [500, 120]]) {
    const list = mkMessages(n, avg);
    const expected = estimateMessagesTokens(list.map(x => ({ role: x.role, content: x.text })));
    assert.equal(messagesMetrics(list).tokens, expected, `n=${n} token 口径漂了`);
  }
  // 定向：一条 4 字中文 = overhead 4 + 4 个 CJK token = 8
  assert.equal(messagesMetrics([{ role: 'user', text: '你好世界' }]).tokens, 8);
  // 工作区形状（content 而非 text）同样要认
  assert.equal(messagesMetrics([{ role: 'user', content: '你好世界' }]).tokens, 8);
});

test('三个数一次扫描产出，且字段齐全', () => {
  const list = mkMessages(10, 100);
  const metrics = messagesMetrics(list);
  assert.deepEqual(Object.keys(metrics).sort(), ['bytesArray', 'bytesJson', 'count', 'tokens']);
  assert.equal(metrics.count, 10);
  assert.ok(metrics.bytesJson > 0 && metrics.bytesArray > metrics.bytesJson && metrics.tokens > 0);
});

test('边界：空数组、null、单条', () => {
  assert.deepEqual(messagesMetrics([]), { count: 0, bytesJson: 0, bytesArray: 2, tokens: 0 });
  assert.equal(bytesArrayOf([]), 2, '空数组序列化为 "[]"，2 字节');
  assert.equal(bytesJsonOf([]), 0, '增量口径不数括号');
  // null 消息：JSON 序列化为 'null'（4 字节）；token 走「角色/分隔开销」4 ——
  // 这与**旧实现完全一致**（实测 estimateHistoryTokens([null]) === 4），不是新引入的偏差。
  assert.deepEqual(messageMetrics(null), { jsonBytes: 4, tokens: 4 });
  assert.equal(messagesMetrics([null]).tokens, 4);
  assert.equal(bytesArrayOf(null), 2, '非数组按空处理');
  assert.equal(messagesMetrics(null).count, 0);
});

test('逐条缓存：同一消息对象重复计量不重复 stringify（引用不变则结果稳定）', () => {
  const message = { id: 'x', role: 'user', text: '正文' };
  const first = messageMetrics(message);
  const second = messageMetrics(message);
  assert.deepEqual(first, second);
  // 消息内容变了但**对象没换**时，缓存会返回旧值——这是既有契约（调用方必须换对象），
  // 与 compaction 的增量估算器、displayTextCache 一致，故在此显式记录。
  message.text = '改了';
  assert.equal(messageMetrics(message).jsonBytes, first.jsonBytes, '同对象就地修改不刷新缓存（契约）');
  // 换新对象才重算。注意必须让**序列化长度真的不同**，否则这条断言区分不出
  // 「重算了」与「命中缓存」（我第一版用等长文本，两边都是 36，等于没验）。
  const longer = { ...message, text: '改了'.repeat(20) };
  assert.ok(
    messageMetrics(longer).jsonBytes > first.jsonBytes,
    `换新对象必须重算：旧 ${first.jsonBytes} / 新 ${messageMetrics(longer).jsonBytes}`
  );
});

test('回归：两套口径的差额不得再靠注释约定（单参误用那类事故的根）', () => {
  // 这条钉的是「差异是显式的」：只要有人把 bytesJsonOf 改成也加括号（或 bytesArrayOf 不加），
  // 差额断言立刻红——而不是等到某天体积算错 2 字节再靠人肉排查。
  const list = mkMessages(3, 60);
  assert.equal(bytesArrayOf(list) - bytesJsonOf(list), ARRAY_BRACKET_BYTES);
  // 逗号也必须是显式的：n 条消息有 n-1 个逗号，逐条之和 + 逗号 = bytesJson
  const sum = list.reduce((acc, item) => acc + JSON.stringify(item).length, 0);
  assert.equal(bytesJsonOf(list) - sum, list.length - 1);
});
