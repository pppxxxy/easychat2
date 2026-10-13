// AS2：多问题确认系统 ConfirmFlow 的**纯逻辑**（零 RN 依赖，Node 直测）。
//
// 为什么单独一个模块：确认的「归一 + 校验 + 结果格式化」是这套东西的全部风险面
// （模型可能发来畸形题卡、选项可能编造、答案可能被截断），而它恰好不需要 UI 就能
// 完整判定。UI（ConfirmFlowSheet）只负责把归一后的题卡画出来、收答案。
//
// 与 ask_user 的分工：ask_user 是「一道选择题、Alert 三按钮」的轻确认，保留不动；
// confirm_flow 补的是它给不了的三件事——① 一次多题（卡组逐题作答）；② 每题的
// 「其他」可以是**列表点选 / 预填可编辑 / 自由输入**三种形态之一；③ 结果整体结构化
// 回传给 agent。典型场景：「每天早上10点整理橘鸦AI早报」→ 弹两题（执行角色=list、
// 任务内容=edit 预填），用户点选角色、改两句措辞，一次确认落定。

export const CONFIRM_FLOW_MAX_QUESTIONS = 4;
export const CONFIRM_FLOW_MAX_OPTIONS = 30;
export const CONFIRM_FLOW_TEXT_MAX = 200;
export const CONFIRM_FLOW_PREFILL_MAX = 2000;
// 三种「其他」形态。
export const CONFIRM_OTHER_TYPES = Object.freeze(['list', 'edit', 'free']);
// 每题的固定两态答案 + 自定义。
export const CONFIRM_ANSWERS = Object.freeze(['yes', 'no', 'custom']);

function clampText(value, max) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

// 归一「其他」配置：非法/缺省一律回落 free（至少能给个输入框，不让题卡坏掉）。
// list 型：agent 可自带 options，也可只写 source（长清单如角色列表由宿主 ctx 提供，
// 防模型编造角色名——它只写 source 名，真实选项由宿主注入）。
export function normalizeConfirmOther(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const type = CONFIRM_OTHER_TYPES.includes(source.type) ? source.type : 'free';
  if (type === 'list') {
    const options = (Array.isArray(source.options) ? source.options : [])
      .map(item => {
        if (item && typeof item === 'object') {
          const id = clampText(item.id, CONFIRM_FLOW_TEXT_MAX);
          const label = clampText(item.label || item.id, CONFIRM_FLOW_TEXT_MAX);
          return id || label ? { id: id || label, label: label || id } : null;
        }
        const text = clampText(item, CONFIRM_FLOW_TEXT_MAX);
        return text ? { id: text, label: text } : null;
      })
      .filter(Boolean)
      .slice(0, CONFIRM_FLOW_MAX_OPTIONS);
    const hostSource = clampText(source.source, 40);
    return { type: 'list', options, source: hostSource };
  }
  if (type === 'edit') {
    return { type: 'edit', prefill: clampText(source.prefill, CONFIRM_FLOW_PREFILL_MAX) };
  }
  return { type: 'free', placeholder: clampText(source.placeholder, CONFIRM_FLOW_TEXT_MAX) };
}

// 归一单题：id 缺省时按序号补；text 必填。
export function normalizeConfirmQuestion(raw, index = 0) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const text = clampText(source.text, CONFIRM_FLOW_TEXT_MAX);
  if (!text) return null;
  const id = clampText(source.id, 40) || `q${index + 1}`;
  return { id, text, other: normalizeConfirmOther(source.other) };
}

// 归一批题：非数组/超上限/全非法 → 空数组（工具据此报 isError）。
// 缺省 id 的补号必须**避开已占用的 id**（含模型显式给过的）：否则模型第一题
// 显式写 id:'q2' 时，第二题的缺省 'q2' 会撞车——那一题被静默丢弃，确认卡组
// 缺了一问而模型毫不知情。
export function normalizeConfirmQuestions(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set();
  const result = [];
  for (const item of list) {
    if (result.length >= CONFIRM_FLOW_MAX_QUESTIONS) break;
    const question = normalizeConfirmQuestion(item, result.length);
    if (!question) continue;
    if (!seen.has(question.id)) {
      seen.add(question.id);
      result.push(question);
      continue;
    }
    // id 撞车：给这题找一个未占用的缺省号（而不是丢弃整题）。
    let fallback = result.length + 1;
    while (seen.has(`q${fallback}`)) fallback += 1;
    const renamed = { ...question, id: `q${fallback}` };
    seen.add(renamed.id);
    result.push(renamed);
  }
  return result;
}

// 宿主注入的选项源（如角色列表）合并进题卡：agent 只写了 source 名时，由宿主把真实
// 选项填进来。source 缺失或宿主没有对应源 → 原样返回（list 退化成空 options，
// UI 侧按 free 兜底渲染，不崩）。
export function hydrateConfirmQuestions(questions, choicesFor) {
  const resolve = typeof choicesFor === 'function' ? choicesFor : null;
  return (Array.isArray(questions) ? questions : []).map(question => {
    const other = question && question.other;
    if (!other || other.type !== 'list' || !other.source || other.options.length > 0) return question;
    const provided = resolve ? resolve(other.source) : null;
    const options = normalizeConfirmOther({ type: 'list', options: provided }).options;
    return { ...question, other: { ...other, options } };
  });
}

// 校验用户回传的答案：每题必须有合法 answer；custom 必须带非空 custom 文本。
// 返回 { ok, answers, cancelled }。整卡取消（用户关掉弹窗）→ cancelled=true。
export function validateConfirmAnswers(questions, answers) {
  const list = Array.isArray(questions) ? questions : [];
  const given = Array.isArray(answers) ? answers : [];
  const byId = new Map();
  for (const item of given) {
    if (item && typeof item === 'object' && item.id) byId.set(String(item.id), item);
  }
  const normalized = [];
  for (const question of list) {
    const raw = byId.get(question.id);
    const answer = raw && CONFIRM_ANSWERS.includes(raw.answer) ? raw.answer : null;
    if (!answer) return { ok: false, answers: [], cancelled: false, missingId: question.id };
    if (answer === 'custom') {
      const custom = clampText(raw.custom, CONFIRM_FLOW_PREFILL_MAX);
      if (!custom) return { ok: false, answers: [], cancelled: false, missingId: question.id };
      normalized.push({ id: question.id, answer, custom });
    } else {
      normalized.push({ id: question.id, answer });
    }
  }
  return { ok: true, answers: normalized, cancelled: false, missingId: '' };
}

// 结果 → 给模型读的自然语言正文（工具返回值）。逐题「问题：答案」，custom 带原文。
export function formatConfirmResult(questions, answers) {
  const byId = new Map((Array.isArray(answers) ? answers : []).map(item => [String(item.id), item]));
  const label = { yes: '是', no: '否' };
  return (Array.isArray(questions) ? questions : [])
    .map(question => {
      const item = byId.get(question.id) || {};
      const value = item.answer === 'custom' ? `其他：${item.custom}` : (label[item.answer] || '未答');
      return `${question.text} → ${value}`;
    })
    .join('\n');
}
