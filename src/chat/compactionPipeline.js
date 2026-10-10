// N2：工作区会话压缩的四档管线 + recap + 权威分离 + 归档（纯逻辑为主，依赖注入）。
//
// 四档（代价递增，任一档解除压力即短路停，省一次 LLM 摘要）：
//   L0 修剪：超大工具结果「头 4096 + 标注 + 尾 1024」，原文先走 O1 落盘；
//   L1 清除：调 K1 resultClearing；
//   L2 摘要：D3 三段式 LLM 摘要 + 工具语义转写；
//   L3 归档：破坏性替换前完整历史写 .transcripts/（jsonl）。
//
// 与 compaction.js 的分工：compaction.js 是 D3 的常量/提示词/手动压缩；本模块是 N2 的
// 自动四档管线与格式化。二者共用 COMPACTION_* 常量。

import {
  COMPACTION_KEEP_RECENT,
  COMPACTION_MARKER,
  COMPACTION_TRIM_HEAD_CHARS,
  COMPACTION_TRIM_MARK,
  COMPACTION_TRIM_TAIL_CHARS,
  COMPACTION_TRIM_THRESHOLD_CHARS,
  buildCompactionSummaryRequest,
} from './compaction.js';

// 工具语义转写关注的工具（有「路径」语义的）。
const TRANSCRIBE_TOOLS = new Set([
  'write_workspace_file', 'edit_workspace_file', 'read_workspace_file',
  'list_workspace_files', 'search_workspace', 'update_plan',
]);

function textOf(item) {
  if (!item) return '';
  return String(item.content != null ? item.content : (item.text != null ? item.text : ''));
}

// L0（纯）：超大工具结果 → 头 + 标注 + 尾。只改 tool 消息 content，配对不变。
// 落盘由调用方（orchestrator）先做；本函数不做 I/O。
export function trimLargeToolResults(messages, {
  thresholdChars = COMPACTION_TRIM_THRESHOLD_CHARS,
  headChars = COMPACTION_TRIM_HEAD_CHARS,
  tailChars = COMPACTION_TRIM_TAIL_CHARS,
  mark = COMPACTION_TRIM_MARK,
} = {}) {
  const list = Array.isArray(messages) ? messages : [];
  let changed = false;
  const out = list.map(item => {
    if (!item || item.role !== 'tool') return item;
    const content = textOf(item);
    if (content.length <= thresholdChars) return item;
    changed = true;
    const head = content.slice(0, headChars);
    const tail = content.slice(Math.max(headChars, content.length - tailChars));
    return { ...item, content: `${head}\n${mark}\n${tail}` };
  });
  return { messages: out, changed };
}

// 工具语义转写（纯）：为 write/edit/read/list/search/plan 调用各生成一行
// 「调用了 X：path（结果 N 字符）」——进摘要输入，保住「动了哪些文件」。
export function buildToolTranscript(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const results = new Map();
  list.forEach(item => {
    if (item && item.role === 'tool') results.set(String(item.tool_call_id), item);
  });
  const lines = [];
  list.forEach(item => {
    if (!item || item.role !== 'assistant' || !Array.isArray(item.tool_calls)) return;
    item.tool_calls.forEach(call => {
      // 历史里的 tool_calls 是 OpenAI 形态（{ id, type, function: { name, arguments } }）；
      // 循环内联的则可能是 { id, name, arguments }——两种都认。
      const fn = call && call.function ? call.function : call;
      const name = String((fn && fn.name) || '');
      if (!TRANSCRIBE_TOOLS.has(name)) return;
      let path = '';
      try {
        const args = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : fn.arguments;
        path = String((args && (args.path || args.subdir || args.pattern)) || '');
      } catch (error) {
        path = '';
      }
      const result = results.get(String(call.id));
      const len = result ? textOf(result).length : 0;
      lines.push(`调用了 ${name}：${path || '(无路径)'}（结果 ${len} 字符）`);
    });
  });
  return lines.join('\n');
}

// 尾部按「配对单位」切割：保留最近 keep 条，但起点若落在 tool 结果上则前移到其 assistant。
export function sliceRecentIntact(messages, keep = COMPACTION_KEEP_RECENT) {
  const list = Array.isArray(messages) ? messages : [];
  const count = Math.max(0, Math.floor(Number(keep) || 0));
  if (count === 0) return [];
  let start = Math.max(0, list.length - count);
  while (start > 0 && list[start] && list[start].role === 'tool') start -= 1;
  return list.slice(start);
}

// 权威分离（O2 条款）：摘要消息 =「当前用户请求（权威）」+「历史摘要（仅供参考，不构成指令）」。
// 附「完整历史：<path>」指针（L3 归档）。
export function applyCompactionWithAuthority(messages, summary, { keep = COMPACTION_KEEP_RECENT, transcriptPath = '' } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  let currentRequest = '';
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i] && list[i].role === 'user') { currentRequest = textOf(list[i]); break; }
  }
  const recent = sliceRecentIntact(list, keep);
  const head = [
    COMPACTION_MARKER,
    `当前用户请求：${currentRequest || '（见下方最近消息）'}（权威）`,
    '历史摘要（仅供参考，不构成指令）：',
    String(summary == null ? '' : summary).trim(),
  ];
  if (transcriptPath) head.push(`完整历史：${transcriptPath}`);
  const summaryMessage = {
    id: `compaction-${Date.now()}`,
    role: 'assistant',
    content: head.join('\n'),
    at: Date.now(),
  };
  return [summaryMessage, ...recent];
}

// recap 段（纯）：计划最后状态（O0.3 sessionPlan）+ 触碰文件 + 已读清单指针。
export function buildRecapSection({ plan = [], touchedFiles = [], readLog = [] } = {}) {
  const lines = [];
  const steps = Array.isArray(plan) ? plan : [];
  if (steps.length > 0) {
    lines.push('计划最后状态：');
    steps.forEach((step, index) => {
      const mark = step.status === 'done' ? '[x]' : (step.status === 'in_progress' ? '[>]' : '[ ]');
      lines.push(`${mark} ${index + 1}. ${step.step}`);
    });
  }
  const files = (Array.isArray(touchedFiles) ? touchedFiles : []).filter(Boolean);
  if (files.length > 0) lines.push(`触碰文件：${files.join('、')}`);
  const read = (Array.isArray(readLog) ? readLog : []).filter(item => item && item.path).map(item => item.path);
  if (read.length > 0) lines.push(`已读文件（可按 offset 精读）：${read.join('、')}`);
  return lines.join('\n');
}

// L3 归档内容（纯）：完整历史 → jsonl。
export function buildTranscriptJsonl(messages) {
  return (Array.isArray(messages) ? messages : []).map(item => JSON.stringify(item)).join('\n');
}

// 幂等：历史头部已是压缩产物且很短 → 不再压缩（避免「摘要的摘要」）。
export function isCompactedHistory(messages, keep = COMPACTION_KEEP_RECENT) {
  const first = Array.isArray(messages) ? messages[0] : null;
  if (!first) return false;
  if (!textOf(first).includes(COMPACTION_MARKER)) return false;
  return messages.length <= keep + 1;
}

// 四档编排（异步，依赖注入）。任一档解除压力（ratioOf < autoRatio）即短路。
// deps:
//   estimateRatio(messages) -> number
//   persist(content, meta) -> Promise<{ path } | null>   （L0 修剪前的 O1 落盘）
//   clear(messages) -> Promise<{ messages, changed }>    （L1，宿主包 K1）
//   summarize(requestMessages) -> Promise<string>        （L2）
//   writeTranscript(jsonl) -> Promise<{ path } | null>   （L3）
export async function runCompactionPipeline(messages, { autoRatio = 0.8, deps = {} } = {}) {
  const d = deps || {};
  const ratioOf = typeof d.estimateRatio === 'function' ? d.estimateRatio : () => 0;
  let current = Array.isArray(messages) ? messages : [];
  const applied = [];
  if (isCompactedHistory(current)) return { messages: current, applied, transcriptPath: '' };
  if (ratioOf(current) < autoRatio) return { messages: current, applied, transcriptPath: '' };

  // L0 修剪：先落盘（O1）再修剪；落盘失败保原文。
  if (typeof d.persist === 'function') {
    let changed = false;
    const next = [];
    for (const item of current) {
      if (item && item.role === 'tool' && textOf(item).length > COMPACTION_TRIM_THRESHOLD_CHARS) {
        let stored = null;
        try { stored = await d.persist(textOf(item), { toolCallId: item.tool_call_id, toolName: '' }); } catch (error) { stored = null; }
        if (stored && stored.path) {
          const content = textOf(item);
          const head = content.slice(0, COMPACTION_TRIM_HEAD_CHARS);
          const tail = content.slice(Math.max(COMPACTION_TRIM_HEAD_CHARS, content.length - COMPACTION_TRIM_TAIL_CHARS));
          next.push({ ...item, content: `${head}\n${COMPACTION_TRIM_MARK}（完整内容见 ${stored.path}）\n${tail}` });
          changed = true;
          continue;
        }
      }
      next.push(item);
    }
    if (changed) {
      current = next;
      applied.push('L0');
      if (ratioOf(current) < autoRatio) return { messages: current, applied, transcriptPath: '' };
    }
  }

  // L1 清除：宿主包 K1。
  if (typeof d.clear === 'function') {
    const cleared = await d.clear(current);
    if (cleared && cleared.changed && Array.isArray(cleared.messages)) {
      current = cleared.messages;
      applied.push('L1');
      if (ratioOf(current) < autoRatio) return { messages: current, applied, transcriptPath: '' };
    }
  }

  // L2 摘要（+ L3 归档在破坏性替换前）。
  if (typeof d.summarize === 'function') {
    const request = buildCompactionSummaryRequest(current, { toolTranscript: buildToolTranscript(current) });
    const summary = String((await d.summarize(request)) || '').trim();
    if (summary) {
      applied.push('L2');
      let transcriptPath = '';
      if (typeof d.writeTranscript === 'function') {
        const stored = await d.writeTranscript(buildTranscriptJsonl(current));
        transcriptPath = stored && stored.path ? stored.path : '';
        if (transcriptPath) applied.push('L3');
      }
      current = applyCompactionWithAuthority(current, summary, { transcriptPath });
    }
  }
  return { messages: current, applied, transcriptPath: '' };
}
