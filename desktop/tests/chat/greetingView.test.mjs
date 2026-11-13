// 桌面开场白视图（greetingView）的行为测试。
//
// 每条约束都对应一个真实故障：
//   · 「+」新建的会话发不出消息 —— 根因是 greetingSelected 没被置位，而置位条件
//     就是 startNewSession 收到了 opening（哪怕正文为空）。newSessionOpening 恒返回对象，
//     把这条不变量钉死在这里；
//   · 选「不使用开场白」被误判成「没选」→ 又回到发不出消息；
//   · 换开场白时把消息 id 也换掉 → 重新生成/分支/引用按 id 定位全部失效；
//   · {{user}} 没替换 → 界面上直接出现占位符。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyGreetingToMessages,
  greetingCandidatesOf,
  greetingMessageFor,
  greetingPickerState,
  greetingSelection,
  newSessionOpening,
} from '../../src/chat/greetingView.js';

const character = {
  firstMes: '  第一句 {{user}}  ',
  alternateGreetings: ['第二句', '   ', '第三句'],
};

test('greetingCandidatesOf：firstMes 在前，空白项剔除', () => {
  const list = greetingCandidatesOf(character);
  assert.deepEqual(list.map(item => item.text), ['第一句 {{user}}', '第二句', '第三句']);
  assert.deepEqual(list.map(item => item.source), ['first', 'alt', 'alt']);
  // 空角色不抛，返回空数组（选择器要能打开后显示「新增」）。
  assert.deepEqual(greetingCandidatesOf(null), []);
  assert.deepEqual(greetingCandidatesOf({}), []);
});

test('greetingPickerState：已有开场白选中它；不在候选里回落到第一条', () => {
  const sessionId = 's1';
  const withGreeting = greetingPickerState({
    character,
    sessionId,
    messages: [{ id: `greeting-${sessionId}`, role: 'assistant', text: '第二句', kind: 'greeting' }],
  });
  assert.equal(withGreeting.initialSelectedIndex, 1);
  assert.equal(withGreeting.currentText, '第二句');

  // 用户改过正文、模板也对不上 → 回落第一条，而不是 -1（否则一开弹窗就成了「不使用」）。
  const drifted = greetingPickerState({
    character,
    sessionId,
    messages: [{ id: `greeting-${sessionId}`, role: 'assistant', text: '被我改过', kind: 'greeting' }],
  });
  assert.equal(drifted.initialSelectedIndex, 0);

  // 没有开场白：默认第一条候选。
  const empty = greetingPickerState({ character, sessionId, messages: [] });
  assert.equal(empty.initialSelectedIndex, 0);
  assert.equal(empty.currentText, '');

  // 角色没有候选且会话没有开场白：-1 = 不使用开场白。
  const nothing = greetingPickerState({ character: {}, sessionId, messages: [] });
  assert.equal(nothing.initialSelectedIndex, -1);
});

test('greetingPickerState：greetingTemplate 优先于 text（用户改过正文时模板才是原文）', () => {
  const state = greetingPickerState({
    character,
    sessionId: 's1',
    messages: [{
      id: 'greeting-s1',
      role: 'assistant',
      text: '第一句 张三',
      greetingTemplate: '第一句 {{user}}',
      kind: 'greeting',
    }],
  });
  assert.equal(state.currentText, '第一句 {{user}}');
  assert.equal(state.initialSelectedIndex, 0, '模板能对上候选，应选中它而不是回落');
});

test('greetingSelection：写回角色卡 + 生成正文（{{user}} 替换、模板保留占位）', () => {
  const picked = greetingSelection(['第一句 {{user}}', '第二句'], 0, { userName: '张三', fallbackUserName: '用户' });
  assert.equal(picked.patch.firstMes, '第一句 {{user}}');
  assert.deepEqual(picked.patch.alternateGreetings, ['第二句']);
  assert.equal(picked.openingText, '第一句 张三');
  assert.equal(picked.openingTemplate, '第一句 {{user}}', '模板必须保留占位符');

  // 用户名为空：用兜底词条，绝不把 {{user}} 原样抛给用户看。
  const anon = greetingSelection(['你好 {{user}}'], 0, { userName: '', fallbackUserName: '用户' });
  assert.equal(anon.openingText, '你好 用户');

  // 不使用开场白：firstMes 清空，其余保留为备用；正文为空。
  const none = greetingSelection(['第一句', '第二句'], -1, {});
  assert.equal(none.patch.firstMes, '');
  assert.deepEqual(none.patch.alternateGreetings, ['第一句', '第二句']);
  assert.equal(none.openingText, '');
});

test('newSessionOpening：即使不使用开场白也返回对象（发送闸门的放行条件）', () => {
  // 这条是「新建对话发不出消息」的根因回归：startNewSession 判
  // greetingSelected = opening !== null && opening !== undefined。
  const none = newSessionOpening({ openingText: '', openingTemplate: '' });
  assert.equal(typeof none, 'object');
  assert.notEqual(none, null);
  assert.deepEqual(none, { text: '', template: '' });

  const some = newSessionOpening({ openingText: '你好', openingTemplate: '你好' });
  assert.deepEqual(some, { text: '你好', template: '你好' });

  // 传 undefined 也不能落成 null（否则闸门又关上）。
  assert.deepEqual(newSessionOpening(undefined), { text: '', template: '' });
});

test('greetingMessageFor：firstMes 为空则不造消息', () => {
  assert.equal(greetingMessageFor('s1', { firstMes: '  ' }, {}), null);
  assert.equal(greetingMessageFor('s1', null, {}), null);
  const built = greetingMessageFor('s1', { firstMes: '你好 {{user}}' }, { userName: '张三' });
  assert.equal(built.id, 'greeting-s1');
  assert.equal(built.kind, 'greeting');
  assert.equal(built.text, '你好 张三');
  assert.equal(built.greetingTemplate, '你好 {{user}}');
});

test('applyGreetingToMessages：插入 / 原位替换 / 删除三态', () => {
  const sessionId = 's1';
  const others = [
    { id: 'm1', role: 'user', text: '在吗' },
    { id: 'm2', role: 'assistant', text: '在' },
  ];
  const greeting = greetingMessageFor(sessionId, { firstMes: '开场' }, {});

  // 没有开场白 → 插到最前。
  const inserted = applyGreetingToMessages(others, sessionId, greeting);
  assert.equal(inserted.length, 3);
  assert.equal(inserted[0].kind, 'greeting');

  // 已有开场白 → 原位替换正文，id 与 timestamp 保持不变。
  const existing = [{ id: 'greeting-s1', role: 'assistant', text: '旧的', timestamp: 111, kind: 'greeting' }, ...others];
  const replaced = applyGreetingToMessages(existing, sessionId, greeting);
  assert.equal(replaced.length, 3, '替换不得新增消息');
  assert.equal(replaced[0].text, '开场');
  assert.equal(replaced[0].id, 'greeting-s1');
  assert.equal(replaced[0].timestamp, 111);

  // 选「不使用开场白」→ 只删开场白，别的消息一条不动。
  const removed = applyGreetingToMessages(existing, sessionId, null);
  assert.deepEqual(removed.map(item => item.id), ['m1', 'm2']);

  // 入参不被修改。
  assert.equal(existing[0].text, '旧的');
});