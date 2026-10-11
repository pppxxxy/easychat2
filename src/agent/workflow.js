// 依赖式工作流（编排原语，对齐 dsh workflows / Claude Code 的编排思路）。
//
// 把一组子任务按 dependsOn 组成 DAG：无依赖的步骤并行执行，有依赖的等前置完成后再跑，
// 并把前置步骤的结论拼进本步 task（供其参考）。纯调度逻辑，可 Node 直测；执行器注入。

import { mapWithConcurrency } from './subagent.js';

export const WORKFLOW_MAX_STEPS = 8;
export const WORKFLOW_CONCURRENCY = 2;

// 归一化步骤：{ id, task, dependsOn, agent, mode }。
export function normalizeWorkflowSteps(steps) {
  return (Array.isArray(steps) ? steps : [])
    .map((raw, index) => {
      const source = raw && typeof raw === 'object' ? raw : {};
      return {
        id: String(source.id || `step-${index + 1}`).trim(),
        task: String(source.task || '').trim(),
        dependsOn: Array.isArray(source.dependsOn) ? source.dependsOn.map(item => String(item)) : [],
        agent: String(source.agent || '').trim(),
        mode: String(source.mode || 'read').toLowerCase() === 'write' ? 'write' : 'read',
      };
    })
    .filter(step => step.task)
    .slice(0, WORKFLOW_MAX_STEPS);
}

// 校验 + 拓扑分层（Kahn）。返回 { ok, waves, order, errors }。waves[i] 是第 i 层可并行的步骤 id。
export function planWorkflow(steps) {
  const list = normalizeWorkflowSteps(steps);
  const errors = [];
  const ids = new Set();
  for (const step of list) {
    if (ids.has(step.id)) errors.push(`重复的步骤 id：${step.id}`);
    ids.add(step.id);
  }
  for (const step of list) {
    for (const dep of step.dependsOn) {
      if (dep === step.id) errors.push(`步骤 ${step.id} 依赖自身`);
      else if (!ids.has(dep)) errors.push(`步骤 ${step.id} 依赖不存在的步骤：${dep}`);
    }
  }
  if (errors.length) return { ok: false, waves: [], order: [], errors };

  const done = new Set();
  const waves = [];
  let guard = 0;
  while (done.size < list.length && guard <= list.length) {
    guard += 1;
    const wave = list.filter(step => !done.has(step.id)
      && step.dependsOn.every(dep => done.has(dep)));
    if (wave.length === 0) break; // 环
    wave.forEach(step => done.add(step.id));
    waves.push(wave.map(step => step.id));
  }
  if (done.size < list.length) {
    return { ok: false, waves: [], order: [], errors: ['步骤依赖成环，无法排序'] };
  }
  return { ok: true, waves, order: waves.flat(), errors: [] };
}

// 执行：按层跑，层内并发受限；runStep(step) 由调用方注入（返回结论字符串）。
// 有依赖的步骤，其 task 会拼上前置结论。返回 { ok, results: { id: text }, order, errors }。
export async function runWorkflow({
  steps,
  runStep,
  concurrency = WORKFLOW_CONCURRENCY,
  signal = null,
  onStep = null,
} = {}) {
  const list = normalizeWorkflowSteps(steps);
  const plan = planWorkflow(list);
  if (!plan.ok) return { ok: false, results: {}, order: [], errors: plan.errors };
  if (typeof runStep !== 'function') return { ok: false, results: {}, order: [], errors: ['缺少步骤执行器'] };

  const byId = new Map(list.map(step => [step.id, step]));
  const results = {};
  for (const wave of plan.waves) {
    if (signal && signal.aborted) break;
    const waveResults = await mapWithConcurrency(wave, concurrency, async id => {
      const step = byId.get(id);
      const deps = step.dependsOn
        .map(dep => `【前置步骤 ${dep} 的结论】\n${String(results[dep] || '（无）')}`)
        .join('\n\n');
      const task = deps ? `${step.task}\n\n（以下是前置步骤的结论，供你参考，不必重复检索）\n${deps}` : step.task;
      if (typeof onStep === 'function') {
        try { onStep({ phase: 'start', id }); } catch (error) {}
      }
      const text = await runStep({ ...step, task });
      if (typeof onStep === 'function') {
        try { onStep({ phase: 'end', id }); } catch (error) {}
      }
      return String(text == null ? '' : text);
    });
    wave.forEach((id, index) => { results[id] = waveResults[index]; });
  }
  return { ok: true, results, order: plan.order, errors: [] };
}
