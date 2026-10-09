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
  const panel = fs.readFileSync(path.resolve('src/workspace/screen/ChatPanel.js'), 'utf8');
  assert.ok(panel.includes("event.name === 'update_plan'"), '工具事件接 update_plan');
  assert.ok(panel.includes('normalizePlanSteps(event.args && event.args.plan)'), '用共用归一函数');
  assert.ok(panel.includes("t('workspace.chat.plan.title'"), '进度条文案（完成计数）');
  assert.ok(panel.includes('setPlanCollapsed'), '可收起');
  const clearCount = (panel.match(/setAgentPlan\(\[\]\)/g) || []).length;
  assert.ok(clearCount >= 2, '新对话与切对话两处都清空');

  // loop.js：start 事件带解析后的参数（订阅方的数据来源）
  const loop = fs.readFileSync(path.resolve('src/agent/loop.js'), 'utf8');
  assert.ok(loop.includes('args: parseToolArgs(call)'), 'start 事件带 args');
  assert.ok(loop.includes('export function parseToolArgs'), 'parseToolArgs 纯函数可测');
});
