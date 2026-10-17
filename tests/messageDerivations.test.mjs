// 按消息引用增量维护的派生容器：与「全量重建」逐字节等价。
//
// 为什么必须这么测：这三个函数的唯一价值是**快**，而它们替换掉的是一目了然的全量实现。
// 所以判据不是「跑得通」，而是「在任意消息序列下，结果与全量重建完全一致」——
// 用随机化 + 定向用例把两者对比，任何一处语义漂移（漏删已删除消息的 id、
// hasUser 判定错位、pending 过滤失效）都会立刻显形。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createRawTextIndex,
  createRegenerableIndex,
  createScrubberListIndex,
} from '../src/chat/messageDerivations.js';

// ---- 参照实现（逐字复制自 ChatScreen.js 改造前的写法）----
function rawTextFull(messages) {
  const map = new Map();
  (Array.isArray(messages) ? messages : []).forEach(message => {
    if (message && message.id) map.set(message.id, String(message.text ?? ''));
  });
  return map;
}
function regenerableFull(messages) {
  const ids = new Set();
  let hasUser = false;
  for (const item of messages) {
    if (!item) continue;
    if (item.role === 'user') hasUser = true;
    else if (item.role === 'assistant' && hasUser) ids.add(item.id);
  }
  return ids;
}
function scrubberFull(messages) {
  return (Array.isArray(messages) ? messages : []).filter(message => (
    message
    && !message.pending
    && (message.role === 'user' || message.role === 'assistant')
  ));
}

const msg = (id, role, text = '', extra = {}) => ({ id, role, text, ...extra });

test('rawTextById：与全量重建等价（含流式追加、编辑、删除、切会话）', () => {
  const get = createRawTextIndex();
  const base = [msg('a', 'user', '甲'), msg('b', 'assistant', '乙')];
  assert.deepEqual([...get(base)], [...rawTextFull(base)]);

  // 流式追加
  const appended = [...base, msg('c', 'assistant', '丙')];
  assert.deepEqual([...get(appended)], [...rawTextFull(appended)]);

  // 尾部更新（流式最常见：最后一条换新对象）
  const streamed = [...base, { ...appended[2], text: '丙丙' }];
  assert.deepEqual([...get(streamed)], [...rawTextFull(streamed)]);

  // 中间编辑（前缀只能复用到编辑点之前）
  const edited = [base[0], { ...base[1], text: '乙乙' }, appended[2]];
  assert.deepEqual([...get(edited)], [...rawTextFull(edited)]);

  // 删除尾部：已删除的 id 必须从 Map 里消失（否则仍能查到正文）
  const shrunk = edited.slice(0, 2);
  assert.deepEqual([...get(shrunk)], [...rawTextFull(shrunk)]);
  assert.equal(get(shrunk).has('c'), false, '已删除消息的 id 不得残留');

  // 切会话：整个数组换新引用
  const other = [msg('x', 'user', '另')];
  assert.deepEqual([...get(other)], [...rawTextFull(other)]);
});

test('rawTextById：没有 id 的消息不入表；text 缺失归一为空串', () => {
  const get = createRawTextIndex();
  const list = [{ role: 'user', text: '无 id' }, { id: 'k', role: 'user' }, { id: 'n', role: 'user', text: null }];
  const result = get(list);
  assert.deepEqual([...result], [...rawTextFull(list)]);
  assert.equal(result.has('k'), true);
  assert.equal(result.get('k'), '');
  assert.equal(result.get('n'), '');
});

test('regenerableIds：与全量重建等价（USER 之后才有可重生的 ASSISTANT）', () => {
  const get = createRegenerableIndex();
  const cases = [
    [msg('a1', 'assistant', '先来的助手')], // USER 之前：不可重生
    [msg('a1', 'assistant'), msg('u1', 'user'), msg('a2', 'assistant')],
    [msg('u1', 'user'), msg('a1', 'assistant'), msg('u2', 'user'), msg('a2', 'assistant')],
    [msg('u1', 'user'), msg('s1', 'system'), msg('a1', 'assistant')],
    [msg('u1', 'user'), null, msg('a1', 'assistant')],
  ];
  for (const list of cases) {
    assert.deepEqual([...get(list)].sort(), [...regenerableFull(list)].sort(), JSON.stringify(list));
  }
});

test('regenerableIds：增量追加后判定仍然正确（含先助手后用户的关键顺序）', () => {
  const get = createRegenerableIndex();
  let list = [msg('a1', 'assistant')];
  assert.deepEqual([...get(list)].sort(), [], '还没出现 USER，不可重生');
  list = [...list, msg('u1', 'user')];
  assert.deepEqual([...get(list)].sort(), [...regenerableFull(list)].sort());
  list = [...list, msg('a2', 'assistant')];
  assert.deepEqual([...get(list)].sort(), ['a2']);
  list = [...list, msg('a3', 'assistant')];
  assert.deepEqual([...get(list)].sort(), ['a2', 'a3']);
  // 删除尾部
  list = list.slice(0, 3);
  assert.deepEqual([...get(list)].sort(), [...regenerableFull(list)].sort());
  assert.equal(get(list).has('a3'), false, '已删除消息不得仍可重生');
});

test('scrubberMessages：与全量重建等价（过滤 pending 与非 user/assistant）', () => {
  const get = createScrubberListIndex();
  const base = [
    msg('u1', 'user', '问'),
    msg('p1', 'assistant', '占位', { pending: true }),
    msg('a1', 'assistant', '答'),
    msg('s1', 'system', '系统'),
  ];
  assert.deepEqual(get(base).map(m => m.id), scrubberFull(base).map(m => m.id));
  assert.deepEqual(get(base).map(m => m.id), ['u1', 'a1'], 'pending 与 system 都要滤掉');

  // 流式追加（尾部新对象）
  const appended = [...base, msg('a2', 'assistant', '再答')];
  assert.deepEqual(get(appended).map(m => m.id), scrubberFull(appended).map(m => m.id));

  // 占位符结算（pending 变 false）——此时它是中间某条被替换
  const settled = appended.map(m => (m.id === 'p1' ? { ...m, pending: false } : m));
  assert.deepEqual(get(settled).map(m => m.id), scrubberFull(settled).map(m => m.id));
  assert.ok(get(settled).map(m => m.id).includes('p1'), '结算后应进入定位条');
});

test('等价性：随机序列下三个容器都与全量重建一致（200 轮）', () => {
  const getRaw = createRawTextIndex();
  const getRegen = createRegenerableIndex();
  const getScrub = createScrubberListIndex();
  let seed = 20261017;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const roles = ['user', 'assistant', 'system'];
  let list = [];
  for (let round = 0; round < 200; round += 1) {
    const action = rand();
    if (action < 0.55 || list.length === 0) {
      // 追加
      list = [...list, {
        id: `m${round}`,
        role: roles[Math.floor(rand() * roles.length)],
        text: `正文${round}`,
        pending: rand() < 0.15,
      }];
    } else if (action < 0.8) {
      // 更新尾部
      list = [...list.slice(0, -1), { ...list[list.length - 1], text: `改${round}` }];
    } else if (action < 0.92) {
      // 中间编辑
      const index = Math.floor(rand() * list.length);
      list = list.map((item, i) => (i === index ? { ...item, text: `编辑${round}` } : item));
    } else {
      // 截断
      list = list.slice(0, Math.max(1, Math.floor(rand() * list.length)));
    }
    assert.deepEqual([...getRaw(list)], [...rawTextFull(list)], `第 ${round} 轮 rawText`);
    assert.deepEqual([...getRegen(list)].sort(), [...regenerableFull(list)].sort(), `第 ${round} 轮 regenerable`);
    assert.deepEqual(getScrub(list).map(m => m.id), scrubberFull(list).map(m => m.id), `第 ${round} 轮 scrubber`);
  }
});

test('同一数组引用重复调用返回同一结果（下游 memo 依赖它）', () => {
  const getRaw = createRawTextIndex();
  const getRegen = createRegenerableIndex();
  const getScrub = createScrubberListIndex();
  const list = [msg('u1', 'user', '问'), msg('a1', 'assistant', '答')];
  assert.equal(getRaw(list), getRaw(list));
  assert.equal(getRegen(list), getRegen(list));
  assert.equal(getScrub(list), getScrub(list));
});

test('非数组入参不抛错，按空处理', () => {
  const getRaw = createRawTextIndex();
  const getRegen = createRegenerableIndex();
  const getScrub = createScrubberListIndex();
  assert.deepEqual([...getRaw(null)], []);
  assert.deepEqual([...getRegen(undefined)], []);
  assert.deepEqual(getScrub(null), []);
});
