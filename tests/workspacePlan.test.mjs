// update_plan 工具测试（能力升级任务书 A3）。
// 纯回显：无副作用、不落盘——价值在「让计划与进度出现在工具结果里」。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  PLAN_MAX_STEPS,
  PLAN_STATUSES,
  PLAN_TOOL_DEFINITION,
  formatPlanEcho,
  normalizePlanSteps,
  shouldOfferPlanApproval,
} from '../src/workspace/toolDefs/planTool.js';
import {
  PLAN_TOOL_HINT,
  buildWorkspaceAgentSystemPrompt,
} from '../src/workspace/chat.js';

test('formatPlanEcho：勾选样式 + 完成计数 + 顺序保持', () => {
  const text = formatPlanEcho([
    { step: '读需求', status: 'done' },
    { step: '改代码', status: 'in_progress' },
    { step: '跑测试', status: 'pending' },
  ]);
  assert.match(text, /计划（1\/3 完成）：/);
  assert.match(text, /\[x\] 1\. 读需求/);
  assert.match(text, /\[>\] 2\. 改代码/);
  assert.match(text, /\[ \] 3\. 跑测试/);
  assert.ok(text.indexOf('读需求') < text.indexOf('改代码'), '顺序按传入保持');
});

test('formatPlanEcho：缺省状态按 pending；空 step 跳过；非法状态回落；上限截断', () => {
  const text = formatPlanEcho([
    { step: '只有 step' },
    { step: '   ' },
    { step: '坏状态', status: 'banana' },
    null,
  ]);
  assert.match(text, /\[ \] 1\. 只有 step/, '缺省 pending');
  assert.match(text, /\[ \] 2\. 坏状态/, '非法状态回落 pending');
  assert.equal(text.includes('3.'), false, '空 step 被跳过');

  const many = Array.from({ length: PLAN_MAX_STEPS + 5 }, (unused, index) => ({ step: `步骤${index}` }));
  const capped = formatPlanEcho(many);
  assert.match(capped, new RegExp(`计划（0/${PLAN_MAX_STEPS} 完成）`), '步数有上限');
});

test('formatPlanEcho：空/非法输入永不抛错（规划不该成为失败点）', () => {
  assert.match(formatPlanEcho([]), /计划为空或格式不对/);
  assert.match(formatPlanEcho(null), /计划为空或格式不对/);
  assert.match(formatPlanEcho('not-an-array'), /计划为空或格式不对/);
  assert.match(formatPlanEcho([{}, 42]), /计划为空或格式不对/);
});

test('PLAN_TOOL_DEFINITION：readOnly 纯回显 + schema 带状态枚举', () => {
  assert.equal(PLAN_TOOL_DEFINITION.name, 'update_plan');
  assert.equal(PLAN_TOOL_DEFINITION.readOnly, true, '无副作用：read/write 模式都提供');
  assert.equal(PLAN_TOOL_DEFINITION.requiresConfirmation, undefined, '纯回显不需要逐条确认');
  const plan = PLAN_TOOL_DEFINITION.parameters.properties.plan;
  assert.equal(plan.type, 'array');
  assert.deepEqual(plan.items.properties.status.enum, [...PLAN_STATUSES]);
  // execute 只读 args.plan，返回文本（无副作用）
  const echo = PLAN_TOOL_DEFINITION.execute({}, { plan: [{ step: 'A', status: 'done' }] });
  assert.match(String(echo), /\[x\] 1\. A/);
  assert.match(String(PLAN_TOOL_DEFINITION.execute({}, {})), /计划为空/);
});

test('O0.1：同时多个 in_progress 被拒绝（回显 + 纠正提示，isError）', () => {
  const rejected = PLAN_TOOL_DEFINITION.execute({}, { plan: [
    { step: 'A', status: 'in_progress' },
    { step: 'B', status: 'in_progress' },
  ] });
  assert.equal(rejected.isError, true);
  assert.match(rejected.content, /同时只能有 1 个 in_progress/);
  assert.match(rejected.content, /\[>\] 1\. A/, '仍回显清单便于纠正');

  // 恰好 1 个（或 0 个）in_progress → 正常回显（字符串，无 isError）
  const ok = PLAN_TOOL_DEFINITION.execute({}, { plan: [
    { step: 'A', status: 'in_progress' },
    { step: 'B', status: 'pending' },
  ] });
  assert.equal(typeof ok, 'string');
});

test('O0.3：onPlan 钩子收到归一后的清单；校验失败不落盘', () => {
  const seen = [];
  const options = { onPlan: steps => seen.push(steps) };
  PLAN_TOOL_DEFINITION.execute(options, { plan: [
    { step: 'A', status: 'in_progress' },
    { step: '  ', status: 'pending' },
  ] });
  assert.deepEqual(seen[0], [{ step: 'A', status: 'in_progress' }], '空白步骤被归一剔除');

  // 校验失败（>1 in_progress）→ 不落盘
  PLAN_TOOL_DEFINITION.execute(options, { plan: [
    { step: 'A', status: 'in_progress' },
    { step: 'B', status: 'in_progress' },
  ] });
  assert.equal(seen.length, 1);
});

test('提示词引导：工具真注册了才提 update_plan（与执行类同款纪律）', () => {
  const base = ['list_workspace_files', 'read_workspace_file'];
  const withPlan = buildWorkspaceAgentSystemPrompt({ mode: 'write', tools: [...base, 'update_plan'] });
  assert.match(withPlan, /update_plan/, '注册了就必须告诉模型它能用');
  assert.ok(withPlan.includes(PLAN_TOOL_HINT));

  const withoutPlan = buildWorkspaceAgentSystemPrompt({ mode: 'write', tools: base });
  assert.equal(/update_plan/.test(withoutPlan), false, '没注册就不提');

  // ask 模式即便传了工具名也绝不提（同一条纪律：两道门各管各的）
  const ask = buildWorkspaceAgentSystemPrompt({ mode: 'ask', tools: ['update_plan'] });
  assert.equal(/update_plan/.test(ask), false);
});

test('A3 二期：normalizePlanSteps 归一（回显与进度条共用）+ 进度条接线契约', () => {
  // 归一纯函数：非法项丢弃、status 收敛、超量截断
  assert.deepEqual(
    normalizePlanSteps([
      { step: '读文件', status: 'done' },
      { step: '写测试', status: 'weird' },
      { step: '' },
      null,
      { step: '跑验证', status: 'in_progress' },
    ]),
    [
      { step: '读文件', status: 'done' },
      { step: '写测试', status: 'pending' },
      { step: '跑验证', status: 'in_progress' },
    ]
  );
  assert.deepEqual(normalizePlanSteps(null), []);
  assert.deepEqual(normalizePlanSteps('oops'), []);
  assert.equal(normalizePlanSteps(Array.from({ length: 30 }, (_, i) => ({ step: `s${i}` }))).length, PLAN_MAX_STEPS);

  // 回显与归一一致（同一份数据源，两处显示永不漂移）
  const echo = formatPlanEcho([{ step: 'a', status: 'done' }, { step: 'b' }]);
  assert.ok(echo.includes('计划（1/2 完成）'));

  // 接线契约：ChatPanel 从工具事件读 update_plan 的 args，会话边界清空
  //
  // ⚠️ FEAT-AC9：这段工具事件处理器已从 ChatPanel 外提到 agentTurnObservation.js
  //（ChatPanel 卡在行数棘轮基线上，且该批要给主对话补回合打点——按纪律拆文件而非抬上限）。
  // 断言的**行为**不变，只是位置变了：处理器读 update_plan 的 args、用共用归一函数。
  // 位置会变、行为不会——所以这里同时对两处断言，避免下次搬家又打自己。
  const panel = fs.readFileSync(path.resolve('src/workspace/screen/ChatPanel.js'), 'utf8');
  const observation = fs.readFileSync(path.resolve('src/workspace/screen/agentTurnObservation.js'), 'utf8');
  const handlerSource = `${panel}\n${observation}`;
  assert.ok(handlerSource.includes("event.name === 'update_plan'"), '工具事件接 update_plan');
  assert.ok(handlerSource.includes('normalizePlanSteps(event.args && event.args.plan)'), '用共用归一函数');
  // 且 ChatPanel 确实把这段接线装上了（不是只定义不用）
  assert.ok(panel.includes('onToolEvent: createAgentToolEventHandler({'),
    'ChatPanel 必须真的用外提后的处理器（否则进度条静默失效）');
  // W1 外提：进度条的渲染（含文案与折叠）搬去 AgentPlanPanel，ChatPanel 只负责把清单传下去。
  const planPanel = fs.readFileSync(path.resolve('src/workspace/screen/AgentPlanPanel.js'), 'utf8');
  assert.ok(planPanel.includes("t('workspace.chat.plan.title'"), '进度条文案（完成计数）');
  assert.ok(planPanel.includes('setCollapsed'), '可收起（折叠态归面板自己）');
  const sidePanels = fs.readFileSync(path.resolve('src/workspace/screen/SessionSidePanels.js'), 'utf8');
  assert.ok(sidePanels.includes('<AgentPlanPanel'), '装配层把清单传给计划面板');
  assert.ok(panel.includes('<SessionSidePanels'), 'ChatPanel 通过装配层渲染');
  const clearCount = (panel.match(/setAgentPlan\(\[\]\)/g) || []).length;
  assert.ok(clearCount >= 2, '新对话与切对话两处都清空');

  // loop.js：start 事件带解析后的参数（订阅方的数据来源）
  const loop = fs.readFileSync(path.resolve('src/agent/loop.js'), 'utf8');
  assert.ok(loop.includes('args: parseToolArgs(call)'), 'start 事件带 args');
  assert.ok(loop.includes('export function parseToolArgs'), 'parseToolArgs 纯函数可测');
});

test('I2 计划批准衔接：判据纯函数 + 接线契约（effect 触发防 mode 闭包 / 草稿保护）', () => {
  // 判据：read ∧ 计划未完成才提议（write 自己能执行；全 done 无可执行）
  assert.equal(shouldOfferPlanApproval({ mode: 'read', plan: [{ step: 'a', status: 'done' }] }), false);
  assert.equal(shouldOfferPlanApproval({ mode: 'read', plan: [{ step: 'a', status: 'in_progress' }] }), true);
  assert.equal(shouldOfferPlanApproval({ mode: 'read', plan: [{ step: 'a' }] }), true, '缺省 pending 算未完成');
  assert.equal(shouldOfferPlanApproval({ mode: 'write', plan: [{ step: 'a' }] }), false);
  assert.equal(shouldOfferPlanApproval({ mode: 'read', plan: [] }), false);
  assert.equal(shouldOfferPlanApproval({}), false);

  // 接线契约：ChatPanel 走 state→effect 触发（防 handleSend 闭包里的旧 mode）
  const screen = fs.readFileSync(path.resolve('src/workspace/screen/ChatPanel.js'), 'utf8');
  assert.ok(screen.includes('pendingPlanRun'), '批准走 state→effect 触发');
  assert.ok(screen.includes("handleSelectMode('write')"), '先切模式（持久化到存储）');
  assert.ok(screen.includes('handleSend(pendingPlanRun)'), '新渲染的 handleSend 发起（write 工具集）');
  // overrideText 路径不碰输入框/草稿/附件（用户可能正在输入别的话）。
  // 判据是「**是字符串**」而不是「非 undefined」：`onPress={handleSend}` 会把点击事件对象
  // 当第一个实参传进来，按「非 undefined」判断会让工作区发什么都变成 "[object Object]"
  //（见 resolveSendText 的注释与回归测试）。
  assert.ok(screen.includes("const hasOverride = typeof overrideText === 'string';"), '判据只算一次');
  const overrideGuardCount = (screen.match(/if \(!hasOverride\)/g) || []).length;
  assert.ok(overrideGuardCount >= 2, 'overrideText 路径有草稿保护（`/compact` 与发送后清空两处共用同一判据）');
  // 计划进度条：W1 外提到 AgentPlanPanel，ChatPanel 经 SessionSidePanels 装配（z1010z7 界面线）。
  const approvalPanel = fs.readFileSync(path.resolve('src/workspace/screen/AgentPlanPanel.js'), 'utf8');
  assert.ok(approvalPanel.includes("t('workspace.chat.planApproval.action')"), '按钮文案进 i18n');
  assert.ok(screen.includes('canApprove={canApprovePlan}'), 'ChatPanel 把批准判据传给装配层');
  // 2026-10-10 回归：发送按钮是 onPress={handleSend}，RN 把点击事件对象当第一实参传进来。
  // 旧判据「overrideText === undefined」认不出事件对象，String(事件) = "[object Object]"，
  // 于是「工作区发啥都变成 [object Object]」。文本解析**只有一处实现**——纯函数
  // resolveSendText（src/workspace/chat.js，行为测试在 workspaceChat.test.mjs）。
  assert.ok(screen.includes('resolveSendText(overrideText, input)'), '文本取用走 resolveSendText 纯函数');
  assert.equal(
    screen.includes("typeof overrideText === 'string' ? overrideText : input"),
    false,
    '不得再内联一份解析（三处判据必须共用 resolveSendText / hasOverride）'
  );
  assert.equal(
    screen.includes('overrideText === undefined ? input : overrideText'),
    false,
    '不得退回「只判 undefined」的旧判据（会把点击事件对象当文本）'
  );
});
