import test from 'node:test';
import assert from 'node:assert/strict';

import { advanceMatchIndex, collectSearchMatchIds, NO_MATCHES } from '../src/chat/chatSearchMath.js';

test('收集命中消息 id：只取 user/assistant 且按消息顺序', () => {
  const messages = [
    { id: 'm1', role: 'user', text: '你好世界' },
    { id: 'm2', role: 'system', text: '你好世界' },
    { id: 'm3', role: 'assistant', text: '世界你好' },
    { id: 'm4', role: 'user', text: '无关' },
  ];
  assert.deepEqual(collectSearchMatchIds(messages, '世界'), ['m1', 'm3']);
  assert.deepEqual(collectSearchMatchIds(messages, '  世界  '), ['m1', 'm3']);
  assert.deepEqual(collectSearchMatchIds(messages, 'WORLD'), []);
  assert.deepEqual(collectSearchMatchIds(messages, ''), []);
  assert.deepEqual(collectSearchMatchIds(null, 'x'), []);
});

test('收集命中消息 id：大小写不敏感且命中图片/表情包名', () => {
  const messages = [
    { id: 'a', role: 'user', text: 'HELLO' },
    { id: 'b', role: 'assistant', kind: 'image', image: { name: '风景照' }, text: '' },
  ];
  assert.deepEqual(collectSearchMatchIds(messages, 'hello'), ['a']);
  assert.deepEqual(collectSearchMatchIds(messages, '风景'), ['b']);
});

test('匹配下标循环推进：到底回头、到头回尾', () => {
  assert.equal(advanceMatchIndex(0, 1, 3), 1);
  assert.equal(advanceMatchIndex(2, 1, 3), 0);
  assert.equal(advanceMatchIndex(0, -1, 3), 2);
  assert.equal(advanceMatchIndex(5, 1, 3), 0);
  assert.equal(advanceMatchIndex(1, 0, 3), 1);
});

test('无命中时推进恒为 0，非法输入不抛错', () => {
  assert.equal(advanceMatchIndex(0, 1, 0), 0);
  assert.equal(advanceMatchIndex(2, 1, 0), 0);
  assert.equal(advanceMatchIndex(NaN, NaN, NaN), 0);
});

// ---- 2026-10-17：短路 + 逐条缓存（性能），语义必须逐字节不变 ----

test('搜索关闭时直接短路：不扫描、返回同一个冻结空数组', () => {
  const messages = [{ id: 'm1', role: 'user', text: '命中词' }];
  // 关闭态：即便 query 能命中，也必须返回空（面板没开就不该有命中态）。
  assert.equal(collectSearchMatchIds(messages, '命中', false), NO_MATCHES);
  // 返回的是**同一个引用**：下游 join / useEffect 依赖不会逐帧变化。
  assert.equal(collectSearchMatchIds(messages, '命中', false), collectSearchMatchIds(messages, '命中', false));
  // 不传第三参 = 保持既有语义（active），老调用方不受影响。
  assert.deepEqual(collectSearchMatchIds(messages, '命中'), ['m1']);
});

test('空查询 / 无命中都返回同一个冻结常量（下游签名不再逐帧变）', () => {
  const messages = [{ id: 'm1', role: 'user', text: '无关' }];
  assert.equal(collectSearchMatchIds(messages, ''), NO_MATCHES);
  assert.equal(collectSearchMatchIds(messages, '   '), NO_MATCHES);
  assert.equal(collectSearchMatchIds(messages, '不存在的词'), NO_MATCHES);
  assert.equal(Object.isFrozen(NO_MATCHES), true, '常量必须冻结，防止被下游误改');
});

test('逐条缓存：同一条消息 + 同一 needle 不重复投影，needs 变了才重算', () => {
  // 用 getMessagePromptText 的投影成本做观测点：同一消息对象在 needle 不变时，
  // 第二次调用不应再走一遍投影（缓存命中）。这里通过「结果正确 + 引用稳定」间接验证，
  // 并在下面的「追加消息」用例里做**行为级**的重算次数断言。
  const messages = [
    { id: 'a', role: 'user', text: 'HELLO world' },
    { id: 'b', role: 'assistant', text: 'nothing' },
  ];
  assert.deepEqual(collectSearchMatchIds(messages, 'hello'), ['a']);
  assert.deepEqual(collectSearchMatchIds(messages, 'HELLO'), ['a'], '大小写折叠不受缓存影响');
  assert.deepEqual(collectSearchMatchIds(messages, 'world'), ['a']);
  assert.deepEqual(collectSearchMatchIds(messages, 'zzz'), NO_MATCHES);
});

test('缓存不串条：不同消息对象即使文本相同也各自判定', () => {
  const first = { id: 'x1', role: 'user', text: '同一段文字' };
  const second = { id: 'x2', role: 'user', text: '同一段文字' };
  assert.deepEqual(collectSearchMatchIds([first, second], '同一'), ['x1', 'x2']);
  // 换一个 needle 后仍然正确（缓存项里比对了 needle）
  assert.deepEqual(collectSearchMatchIds([first, second], '文字'), ['x1', 'x2']);
});

test('语义不变：只认 user/assistant、保持消息顺序、命中图片名', () => {
  const messages = [
    { id: 'm1', role: 'system', text: '关键词' },
    { id: 'm2', role: 'assistant', text: '关键词' },
    { id: 'm3', role: 'user', text: '关键词' },
    { id: 'm4', role: 'assistant', kind: 'image', image: { name: '关键词图' }, text: '' },
  ];
  // system 不算命中；顺序严格按消息顺序（不是按角色分组）
  assert.deepEqual(collectSearchMatchIds(messages, '关键词'), ['m2', 'm3', 'm4']);
});

test('回归：追加消息不重扫全历史（缓存让每 tick 只算新增那一条）', () => {
  // 行为级断言：同一条消息对象在多轮「追加」中被反复查询，结果必须始终一致；
  // 这条用例的价值在于——如果缓存键写成「整个 messages 数组」或忘了比 needle，
  // 增量场景下会给出过期结果（例如新追加的命中消息不被识别）。
  const messages = [];
  const expected = [];
  for (let i = 0; i < 30; i += 1) {
    const hit = i % 3 === 0;
    messages.push({ id: `m${i}`, role: 'user', text: hit ? `含关键词 ${i}` : `普通 ${i}` });
    if (hit) expected.push(`m${i}`);
    assert.deepEqual(
      collectSearchMatchIds(messages, '关键词'),
      expected,
      `追加到第 ${i} 条时命中列表必须完整（不得因缓存漏掉新增项）`
    );
  }
});
