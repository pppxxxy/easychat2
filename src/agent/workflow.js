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

// 结果表：**无原型对象**。键是 `step.id`，而 id 是模型给的（用户可控的任意字符串），
// 普通对象字面量会让 `Object.prototype` 参与进来：
//   · `id: '__proto__'` → `results['__proto__'] = 结论` 走的是原型 setter，
//     字符串值不是对象，赋值被**静默丢弃**；随后读 `results['__proto__']` 拿到的是
//     `Object.prototype`，被 `String(x || '')` 拼成 `[object Object]` —— 该步骤的结论无声消失，
//     合并结果里变成一段乱码；
//   · 同理，`dependsOn: ['__proto__']` 会把 `[object Object]` 拼进下一步的 task，
//     污染模型输入（`dependsOn: ['constructor']` 这类未赋值的原型键同理会取到 Object 构造函数）。
// 无原型对象让「任意字符串 id」都只是一个普通键，从根上消掉这一类问题。
// （2026-10-11 逐行审查 P1-1。）
function newResultTable() {
  return Object.create(null);
}

// 执行：按层跑，层内并发受限；runStep(step) 由调用方注入。
// 有依赖的步骤，其 task 会拼上前置结论。
//
// runStep 的返回契约（2026-10-11 P1）：
//   · 字符串                  —— 旧形状，按「成功、结论就是这段文字」处理（向后兼容）；
//   · { text, isError, error } —— 新形状。isError === true 时本步判为失败：
//     结论仍收进 results（部分信息比空手好），但整个工作流 **ok:false** 并在
//     errors 里点名是哪些步骤失败了。
//
// 为什么必须区分（而不是「有文字就算成功」）：步骤失败时子代理照样会返回一段
// 文字（「写子代理不可用：……（未执行）」），把它当结论合并，就会把「没写的」
// 报成「工作流成功」——授权/执行失败被伪装成完成。失败必须是可判定的。
//
// 返回 { ok, results: { id: text }, order, errors, failed: [id] }。
export async function runWorkflow({
  steps,
  runStep,
  concurrency = WORKFLOW_CONCURRENCY,
  signal = null,
  onStep = null,
} = {}) {
  const list = normalizeWorkflowSteps(steps);
  const plan = planWorkflow(list);
  if (!plan.ok) return { ok: false, results: newResultTable(), order: [], errors: plan.errors, failed: [] };
  if (typeof runStep !== 'function') {
    return { ok: false, results: newResultTable(), order: [], errors: ['缺少步骤执行器'], failed: [] };
  }

  const byId = new Map(list.map(step => [step.id, step]));
  const results = newResultTable();
  const failed = [];
  const errors = [];
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
      const raw = await runStep({ ...step, task });
      if (typeof onStep === 'function') {
        try { onStep({ phase: 'end', id, ok: !(raw && typeof raw === 'object' && raw.isError === true) }); } catch (error) {}
      }
      // 新形状：{ text, isError, error }；旧形状：字符串。
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        return {
          text: String(raw.text == null ? '' : raw.text),
          isError: raw.isError === true,
          error: String(raw.error == null ? '' : raw.error),
        };
      }
      return { text: String(raw == null ? '' : raw), isError: false, error: '' };
    });
    wave.forEach((id, index) => {
      const entry = waveResults[index] || { text: '', isError: false, error: '' };
      results[id] = entry.text;
      if (entry.isError) {
        failed.push(id);
        errors.push(`步骤 ${id} 执行失败：${entry.error || '（无错误说明）'}`);
      }
    });
  }
  if (failed.length > 0) {
    return { ok: false, results, order: plan.order, errors, failed };
  }
  return { ok: true, results, order: plan.order, errors: [], failed: [] };
}
