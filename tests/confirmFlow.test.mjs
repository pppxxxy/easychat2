// AS2：confirm_flow 多题确认系统。
// 三层：纯逻辑（confirmFlow.js）/ 宿主桥（confirmFlowBridge.js）/ 工具端到端（runTool）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONFIRM_FLOW_MAX_QUESTIONS,
  formatConfirmResult,
  hydrateConfirmQuestions,
  normalizeConfirmOther,
  normalizeConfirmQuestions,
  validateConfirmAnswers,
} from '../src/workspace/toolDefs/confirmFlow.js';
import {
  cancelConfirmFlow,
  getPendingConfirmFlow,
  requestConfirmFlow,
  resetConfirmFlowBridge,
  respondConfirmFlow,
  subscribeConfirmFlow,
} from '../src/workspace/screen/confirmFlowBridge.js';
import { CONFIRM_FLOW_TOOL_DEFINITION } from '../src/workspace/toolDefs/confirmFlowTool.js';
import { registerTool, unregisterTool, runTool } from '../src/agent/tools/registry.js';

test.afterEach(() => resetConfirmFlowBridge());

// —— 纯逻辑：归一 ——

test('normalizeConfirmOther：三种形态各归各位，非法回落 free', () => {
  assert.deepEqual(normalizeConfirmOther({ type: 'edit', prefill: '  早报正文  ' }), { type: 'edit', prefill: '早报正文' });
  assert.deepEqual(normalizeConfirmOther({ type: 'free', placeholder: '说点什么' }), { type: 'free', placeholder: '说点什么' });
  assert.deepEqual(normalizeConfirmOther({ type: 'nope' }), { type: 'free', placeholder: '' });
  assert.deepEqual(normalizeConfirmOther(null), { type: 'free', placeholder: '' });
  const list = normalizeConfirmOther({
    type: 'list',
    source: 'characters',
    options: [{ id: 'a', label: '甲' }, '乙', '', null, { id: '', label: '' }],
  });
  assert.equal(list.type, 'list');
  assert.equal(list.source, 'characters');
  assert.deepEqual(list.options, [{ id: 'a', label: '甲' }, { id: '乙', label: '乙' }], '字符串项补 id；空项丢弃');
  const many = normalizeConfirmOther({ type: 'list', options: Array.from({ length: 50 }, (_, i) => `o${i}`) });
  assert.equal(many.options.length, 30, '选项上限 30');
});

test('normalizeConfirmQuestions：1–4 题、id 去重补号、无 text 丢弃、坏输入不抛', () => {
  const list = normalizeConfirmQuestions([
    { text: '由当前的角色来吗', other: { type: 'list', source: 'characters' } },
    { id: 'x', text: '需要润色吗', other: { type: 'edit', prefill: '整理AI早报' } },
    { text: '' },
    null,
    { text: '第五题（超上限）' },
    { text: '第四题' },
  ]);
  assert.equal(list.length, CONFIRM_FLOW_MAX_QUESTIONS);
  assert.equal(list[0].id, 'q1', '缺省按序号补 id');
  assert.equal(list[1].id, 'x');
  assert.deepEqual(normalizeConfirmQuestions('nope'), []);
  assert.deepEqual(normalizeConfirmQuestions(undefined), []);
});

test('normalizeConfirmQuestions：id 撞车时补号而不是静默丢题（不变量）', () => {
  // 模型第一题显式给 id:'q2'，第二题缺省 → 缺省号必须是未占用的（不能撞成同一 id 被丢弃）。
  const list = normalizeConfirmQuestions([
    { id: 'q2', text: '第一题' },
    { text: '第二题' },
  ]);
  assert.equal(list.length, 2, '两题都要在（撞车不得丢题）');
  assert.equal(list[0].id, 'q2');
  assert.notEqual(list[1].id, 'q2', '第二题必须换一个未占用的 id');
  const ids = list.map(item => item.id);
  assert.equal(new Set(ids).size, ids.length, 'id 唯一');
});

test('hydrateConfirmQuestions：list 题只写 source 时由宿主注入真实选项', () => {
  const questions = normalizeConfirmQuestions([
    { text: '选角色', other: { type: 'list', source: 'characters' } },
    { text: '自带选项', other: { type: 'list', options: ['甲', '乙'] } },
    { text: '无宿主源', other: { type: 'list', source: 'unknown' } },
  ]);
  const hydrated = hydrateConfirmQuestions(questions, source => (source === 'characters'
    ? [{ id: 'c1', label: '橘鸦' }, { id: 'c2', label: '小助手' }]
    : null));
  assert.deepEqual(hydrated[0].other.options, [{ id: 'c1', label: '橘鸦' }, { id: 'c2', label: '小助手' }]);
  assert.equal(hydrated[1].other.options.length, 2, 'agent 自带 options 时不覆盖');
  assert.deepEqual(hydrated[2].other.options, [], '宿主没有该源 → 空列表（UI 兜底，不崩）');
  assert.equal(hydrateConfirmQuestions(questions, null)[0].other.options.length, 0, '无 provider 原样');
});

test('validateConfirmAnswers：逐题齐答才 ok；custom 必须带文本；缺答报缺哪题', () => {
  const questions = normalizeConfirmQuestions([{ text: 'A' }, { text: 'B' }]);
  const ok = validateConfirmAnswers(questions, [
    { id: 'q1', answer: 'yes' },
    { id: 'q2', answer: 'custom', custom: ' 改成晚上8点 ' },
  ]);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.answers, [
    { id: 'q1', answer: 'yes' },
    { id: 'q2', answer: 'custom', custom: '改成晚上8点' },
  ]);
  assert.equal(validateConfirmAnswers(questions, [{ id: 'q1', answer: 'yes' }]).missingId, 'q2', '缺 B 题');
  assert.equal(validateConfirmAnswers(questions, [
    { id: 'q1', answer: 'yes' }, { id: 'q2', answer: 'custom', custom: '  ' },
  ]).ok, false, 'custom 空文本 = 未作答');
  assert.equal(validateConfirmAnswers(questions, []).ok, false);
  assert.equal(validateConfirmAnswers(questions, null).ok, false);
});

test('formatConfirmResult：逐题「问题 → 答案」，custom 带原文', () => {
  const questions = normalizeConfirmQuestions([{ text: '由当前角色来吗' }, { text: '要润色吗' }]);
  const text = formatConfirmResult(questions, [
    { id: 'q1', answer: 'yes' },
    { id: 'q2', answer: 'custom', custom: '加上天气' },
  ]);
  assert.match(text, /由当前角色来吗 → 是/);
  assert.match(text, /要润色吗 → 其他：加上天气/);
});

// —— 宿主桥 ——

test('桥：请求挂起 → 面板可见快照 → 提交结算；getSnapshot 引用稳定', async () => {
  assert.equal(getPendingConfirmFlow(), null);
  let notified = 0;
  const off = subscribeConfirmFlow(() => { notified += 1; });
  const promise = requestConfirmFlow({ questions: [{ id: 'q1', text: 'A' }] });
  const snapshot = getPendingConfirmFlow();
  assert.equal(snapshot.questions[0].text, 'A');
  assert.equal(getPendingConfirmFlow(), snapshot, '未变化时同一引用（useSyncExternalStore 契约）');
  assert.equal(notified, 1);
  assert.equal(respondConfirmFlow([{ id: 'q1', answer: 'yes' }]), true);
  assert.deepEqual(await promise, [{ id: 'q1', answer: 'yes' }]);
  assert.equal(getPendingConfirmFlow(), null, '结算后清空');
  assert.equal(respondConfirmFlow([]), false, '没有挂起时提交是空操作');
  off();
});

test('桥：取消 = null；新请求把旧卡按取消结算（同刻只挂一张）', async () => {
  const first = requestConfirmFlow({ questions: [{ id: 'q1', text: 'A' }] });
  const second = requestConfirmFlow({ questions: [{ id: 'q1', text: 'B' }] });
  assert.equal(await first, null, '旧卡被取消');
  assert.equal(cancelConfirmFlow(), true);
  assert.equal(await second, null);
  assert.equal(getPendingConfirmFlow(), null);
});

test('桥：空题列表不挂卡直接结算 null', async () => {
  assert.equal(await requestConfirmFlow({ questions: [] }), null);
  assert.equal(getPendingConfirmFlow(), null);
});

test('桥：超时自动按取消结算（幽灵卡防护——工具超时后题卡不得永远挂着）', async () => {
  const promise = requestConfirmFlow({ questions: [{ id: 'q1', text: 'A' }], timeoutMs: 30 });
  assert.ok(getPendingConfirmFlow(), '挂起中');
  assert.equal(await promise, null, '到点自动结算为取消');
  assert.equal(getPendingConfirmFlow(), null, '结算后清空（不残留定时器/快照）');
  // 结算后再提交 = 空操作（不把答案回给已经放弃的工具）
  assert.equal(respondConfirmFlow([{ id: 'q1', answer: 'yes' }]), false);
});

test('桥：timeoutMs=0 显式关闭超时；非法值回落默认；旧卡定时器不误杀新卡', async () => {
  // 显式 0 = 调用方明确不要超时（不能与「不传」混为一谈：0||默认 会把 0 变成 5 分钟）
  const noTimeout = requestConfirmFlow({ questions: [{ id: 'q1', text: 'A' }], timeoutMs: 0 });
  assert.ok(getPendingConfirmFlow(), '仍挂着（未到任何超时）');
  assert.equal(respondConfirmFlow([{ id: 'q1', answer: 'no' }]), true);
  assert.deepEqual(await noTimeout, [{ id: 'q1', answer: 'no' }]);

  // 非法值（NaN / 字符串）回落默认预算——这里只验「不抛且能正常结算」
  const bad = requestConfirmFlow({ questions: [{ id: 'q1', text: 'A' }], timeoutMs: Number.NaN });
  assert.ok(getPendingConfirmFlow());
  respondConfirmFlow([{ id: 'q1', answer: 'yes' }]);
  assert.equal((await bad).length, 1);

  // 旧卡的定时器晚于换卡触发时，不能把新卡误判成取消
  const oldCard = requestConfirmFlow({ questions: [{ id: 'q1', text: 'old' }], timeoutMs: 25 });
  const newCard = requestConfirmFlow({ questions: [{ id: 'q1', text: 'new' }], timeoutMs: 5000 });
  assert.equal(await oldCard, null, '旧卡按换卡取消');
  await new Promise(resolve => setTimeout(resolve, 60));
  const stillThere = getPendingConfirmFlow();
  assert.ok(stillThere, '新卡不受旧卡定时器影响');
  assert.equal(stillThere.questions[0].text, 'new');
  respondConfirmFlow([{ id: 'q1', answer: 'yes' }]);
  assert.equal((await newCard).length, 1);
});

// —— 工具端到端（runTool）——

// toolDefs 的 execute 签名是 (options, args, ctx)，注册表调的是 (args, ctx)——
// 生产链在 tools.js 的包装层适配；测试按同款方式包一层。
function registeredDefinition() {
  return {
    ...CONFIRM_FLOW_TOOL_DEFINITION,
    execute: (args, ctx) => CONFIRM_FLOW_TOOL_DEFINITION.execute({}, args || {}, ctx || {}),
  };
}

test('confirm_flow 工具：经 runTool 全链（ctx.confirmFlow + choices 注入角色列表）', async () => {
  registerTool(registeredDefinition());
  try {
    const questionsArg = JSON.stringify({
      questions: [
        { text: '由当前的角色来吗', other: { type: 'list', source: 'characters' } },
        { text: '任务内容需要润色吗', other: { type: 'edit', prefill: '整理橘鸦AI早报' } },
      ],
    });
    const running = runTool(
      { name: 'confirm_flow', arguments: questionsArg },
      {
        mode: 'read',
        confirmFlow: requestConfirmFlow,
        choices: source => (source === 'characters' ? [{ id: 'c1', label: '橘鸦' }] : null),
      }
    );
    // runTool 把 tool.execute 推到微任务里——让链先跑起来再读挂起快照。
    await new Promise(resolve => setImmediate(resolve));
    // 面板侧：题卡已挂起，list 题被宿主注入了真实角色。
    const snapshot = getPendingConfirmFlow();
    assert.ok(snapshot, '题卡应已挂到桥上');
    assert.equal(snapshot.questions.length, 2);
    assert.deepEqual(snapshot.questions[0].other.options, [{ id: 'c1', label: '橘鸦' }]);
    respondConfirmFlow([
      { id: 'q1', answer: 'custom', custom: '橘鸦' },
      { id: 'q2', answer: 'yes' },
    ]);
    const result = await running;
    assert.equal(result.isError, false);
    assert.match(result.content, /由当前的角色来吗 → 其他：橘鸦/);
    assert.match(result.content, /任务内容需要润色吗 → 是/);
  } finally {
    unregisterTool('confirm_flow');
  }
});

test('confirm_flow 工具：无宿主钩子 = 问不到不执行；取消 = isError；畸形参数 = isError', async () => {
  registerTool(registeredDefinition());
  try {
    const noHost = await runTool(
      { name: 'confirm_flow', arguments: JSON.stringify({ questions: [{ text: 'A' }] }) },
      { mode: 'read' }
    );
    assert.equal(noHost.isError, true, '没接 confirmFlow 钩子必须拒绝');
    assert.match(noHost.content, /无法向用户发起确认/);

    const bad = await runTool({ name: 'confirm_flow', arguments: '{}' }, { mode: 'read', confirmFlow: async () => [] });
    assert.equal(bad.isError, true, '无有效题目');

    const cancelled = await runTool(
      { name: 'confirm_flow', arguments: JSON.stringify({ questions: [{ text: 'A' }] }) },
      { mode: 'read', confirmFlow: async () => null }
    );
    assert.equal(cancelled.isError, true, '用户取消 = 未执行');
  } finally {
    unregisterTool('confirm_flow');
  }
});

test('词条齐备：confirmFlow 卡组文案 zh/en 都有（漏译界面会显示原始键名）', async () => {
  const { zhCN } = await import('../src/i18n/locales/zh-CN.js');
  const { en } = await import('../src/i18n/locales/en.js');
  for (const [locale, table] of [['zh-CN', zhCN], ['en', en]]) {
    for (const key of [
      'workspace.confirmFlow.yes', 'workspace.confirmFlow.no', 'workspace.confirmFlow.other',
      'workspace.confirmFlow.customChosen', 'workspace.confirmFlow.submit',
      'workspace.confirmFlow.freePlaceholder', 'workspace.confirmFlow.editPlaceholder',
      'workspace.confirmFlow.missing',
    ]) {
      assert.ok(typeof table[key] === 'string' && table[key].length > 0, `${locale} 缺 ${key}`);
    }
    assert.match(table['workspace.confirmFlow.missing'], /\{count\}/);
  }
});
