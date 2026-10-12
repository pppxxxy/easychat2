// 待消费载荷的纯归一化：定位目标（pendingTarget）与引用载荷（pendingQuote）。
// 这两段逻辑从 AppContext 抽到 context/pendingPayloads.js——组件是 RN 代码、Node 里跑不起来，
// 抽成纯函数后能直测，也把 AppContext 压回行数上限内。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizePendingQuote,
  normalizePendingTarget,
} from '../src/context/pendingPayloads.js';

test('normalizePendingTarget：缺 sessionId/messageId 一律 null', () => {
  assert.equal(normalizePendingTarget(null), null);
  assert.equal(normalizePendingTarget(undefined), null);
  assert.equal(normalizePendingTarget({}), null);
  assert.equal(normalizePendingTarget({ sessionId: 's' }), null, '缺 messageId');
  assert.equal(normalizePendingTarget({ messageId: 'm' }), null, '缺 sessionId');
  assert.equal(normalizePendingTarget({ sessionId: '', messageId: 'm' }), null, '空串不算给了');
});

test('normalizePendingTarget：合法输入归一为字符串对', () => {
  assert.deepEqual(
    normalizePendingTarget({ sessionId: 's1', messageId: 'm1', extra: 'ignored' }),
    { sessionId: 's1', messageId: 'm1' },
    '只保留两个字段，多余字段不进载荷',
  );
  assert.deepEqual(
    normalizePendingTarget({ sessionId: 7, messageId: 9 }),
    { sessionId: '7', messageId: '9' },
    '数字 id 归一为字符串',
  );
});

test('normalizePendingQuote：缺 sessionId 或 payload 一律 null', () => {
  assert.equal(normalizePendingQuote(null), null);
  assert.equal(normalizePendingQuote({}), null);
  assert.equal(normalizePendingQuote({ sessionId: 's' }), null, '缺 payload');
  assert.equal(normalizePendingQuote({ payload: { text: 'hi' } }), null, '缺 sessionId');
});

test('normalizePendingQuote：payload 归一——文本 trim、role 兜底 assistant、id 允许空', () => {
  assert.deepEqual(
    normalizePendingQuote({
      sessionId: 's1',
      payload: { id: 'm1', name: '  小红  ', role: 'user', text: '  你好  ' },
    }),
    {
      sessionId: 's1',
      payload: { id: 'm1', name: '小红', role: 'user', text: '你好' },
    },
  );
  // 评论引用：没有会话内消息 id → id 为空串（点引用块不定位，但载荷本身合法）
  assert.deepEqual(
    normalizePendingQuote({ sessionId: 's1', payload: { name: 'A', text: 'x' } }),
    {
      sessionId: 's1',
      payload: { id: '', name: 'A', role: 'assistant', text: 'x' },
    },
  );
});

test('normalizePendingQuote：空文本仍返回载荷，由调用方丢弃（保持旧行为）', () => {
  // 归一化不负责「空文本就不引用」——那一步留在 AppContext（`if (value && !value.payload.text) return;`），
  // 以免把「归一」和「是否接受」两件事混在一起。
  const value = normalizePendingQuote({ sessionId: 's1', payload: { text: '   ' } });
  assert.ok(value, '归一化本身仍给出对象');
  assert.equal(value.payload.text, '');
});
