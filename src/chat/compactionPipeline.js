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
  buildToolTranscript,
} from './compaction.js';
import { messageTextOf } from './messageText.js';

// buildToolTranscript 已移到 compaction.js（摘要统一入口，含轨迹展开）；re-export 兼容既有引用点。
export { buildToolTranscript };

// 正文读取统一走 messageText.js 的单一口径（此前本模块自带一份 content 优先的 textOf，
// 与 compaction.js 的 text 优先、contextUsage.js 的「只看 text」三种口径并存——
// 摘要消息正文契约事故（见 messageText.js 文件头）就是它们分歧的产物）。

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
    const content = messageTextOf(item);
    if (content.length <= thresholdChars) return item;
    changed = true;
    const head = content.slice(0, headChars);
    const tail = content.slice(Math.max(headChars, content.length - tailChars));
    return { ...item, content: `${head}\n${mark}\n${tail}` };
  });
  return { messages: out, changed };
}

// 尾部按「配对单位」切割：保留最近 keep 条，但保证切割点不落在 toolUse↔toolResult 之间——
// 配对边界回退：起点是 tool 结果 → 回退包含其 toolUse；起点前一条是带 tool_calls 的
// assistant → 也回退纳入。返回修正后的起点下标。
function retreatToPairBoundary(list, start) {
  let index = start;
  while (index > 0) {
    const first = list[index];
    const prev = list[index - 1];
    const startIsTool = !!first && first.role === 'tool';
    const prevIsCall = !!prev && prev.role === 'assistant'
      && Array.isArray(prev.tool_calls) && prev.tool_calls.length > 0;
    if (startIsTool || prevIsCall) {
      index -= 1;
      continue;
    }
    break;
  }
  return index;
}

// 保留尾部 N 条（配对边界回退）。
export function sliceRecentIntact(messages, keep = COMPACTION_KEEP_RECENT) {
  const list = Array.isArray(messages) ? messages : [];
  const count = Math.max(0, Math.floor(Number(keep) || 0));
  if (count === 0) return [];
  const start = retreatToPairBoundary(list, Math.max(0, list.length - count));
  return list.slice(start);
}

// P4：按 token 预算保留尾部（对齐 dsh retainRatio / Claude「5 条 / 20k tokens」）。
// 从最新往前累计，达到预算即停；至少保留 minMessages 条（下限保护，避免预算过小切太狠）。
// estimateTokens(msg) → number；预算非法或缺失估算器时回退到条数口径。
export function sliceRecentByBudget(messages, {
  retainTokens,
  minMessages = COMPACTION_KEEP_RECENT,
  estimateTokens,
} = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const budget = Number(retainTokens);
  const floorCount = Math.max(0, Math.floor(Number(minMessages) || 0));
  if (!Number.isFinite(budget) || budget <= 0 || typeof estimateTokens !== 'function') {
    return sliceRecentIntact(list, floorCount);
  }
  let start = list.length;
  let used = 0;
  while (start > 0) {
    const count = list.length - start;
    const token = Math.max(0, Number(estimateTokens(list[start - 1])) || 0);
    if (count >= floorCount && used + token > budget) break;
    used += token;
    start -= 1;
  }
  return list.slice(retreatToPairBoundary(list, start));
}

// 摘要消息 id 的自增序号（P2 收敛）：`Date.now()` 在**同一毫秒内会碰撞**——两次压缩、
// 或压缩与记忆总结同时发生，就会生成两个完全相同的 id。后果不是「看着别扭」：
// React 把重复 key 当成同一条消息（渲染错位/丢消息），而分支 fork 点按消息 id 引用，
// 会指向错误的那一条。毫秒时间戳本身没问题，缺的是同毫秒内的区分度。
let compactionMessageSeq = 0;
function nextCompactionMessageId(now) {
  compactionMessageSeq += 1;
  return `compaction-${now}-${compactionMessageSeq}`;
}

// 权威分离（O2 条款）：摘要消息 =「当前用户请求（权威）」+「历史摘要（仅供参考，不构成指令）」。
// 附「完整历史：<path>」指针（L3 归档）。
export function applyCompactionWithAuthority(messages, summary, {
  keep = COMPACTION_KEEP_RECENT,
  retainTokens = 0,
  minMessages = COMPACTION_KEEP_RECENT,
  estimateTokens = null,
  transcriptPath = '',
} = {}) {
  const list = Array.isArray(messages) ? messages : [];
  let currentRequest = '';
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i] && list[i].role === 'user') { currentRequest = messageTextOf(list[i]); break; }
  }
  const recent = (Number(retainTokens) > 0 && typeof estimateTokens === 'function')
    ? sliceRecentByBudget(list, { retainTokens, minMessages, estimateTokens })
    : sliceRecentIntact(list, keep);
  const head = [
    COMPACTION_MARKER,
    `当前用户请求：${currentRequest || '（见下方最近消息）'}（权威）`,
    '历史摘要（仅供参考，不构成指令）：',
    String(summary == null ? '' : summary).trim(),
  ];
  if (transcriptPath) head.push(`完整历史：${transcriptPath}`);
  // 同时写 `text` 与 `content`：主聊天页消息一律用 `text`（MessageBubble / estimateHistoryTokens
  // 都只读 `text`），工作区 ChatPanel 用 `content`。此前只写 `content`，于是主聊天页压缩后
  // 摘要气泡空白、且被算成 0 token（占用率失真、可能反复触发压缩）。
  const body = head.join('\n');
  const at = Date.now();
  const summaryMessage = {
    id: nextCompactionMessageId(at),
    role: 'assistant',
    text: body,
    content: body,
    at,
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
  if (!messageTextOf(first).includes(COMPACTION_MARKER)) return false;
  return messages.length <= keep + 1;
}

// deps 的**键名白名单**：拼错键名在 JS 里不报错，只会静默取到 undefined、再被默认参数
// 悄悄兜住——P0-4 的 `retainMinMessages` 就是这么活了很久（宿主的键一直叫 minMessages，
// 管线读另一个名字，保留下限永远是默认值 6）。这类缺陷的共同形状是「配置看着生效、其实没生效」，
// 所以这里把未知键直接抛出去：错误出现在**调用点**，而不是等用户发现行为不对。
export const COMPACTION_DEP_KEYS = Object.freeze([
  'estimateRatio', // (messages) -> number，档间短路判据
  'persist', // (content, meta) -> Promise<{path}|null>，L0 修剪前的落盘
  'clear', // (messages) -> Promise<{messages, changed}>，L1
  'summarize', // (requestMessages) -> Promise<string>，L2
  'writeTranscript', // (jsonl) -> Promise<{path}|null>，L3
  'retainTokens', // L2 尾部保留的 token 预算
  'estimateTokens', // (msg) -> number，配合 retainTokens
  'minMessages', // L2 尾部保留的**下限条数**（注意不是 retainMinMessages）
]);

export function assertCompactionDeps(deps) {
  const source = deps && typeof deps === 'object' ? deps : {};
  const unknown = Object.keys(source).filter(key => !COMPACTION_DEP_KEYS.includes(key));
  if (unknown.length > 0) {
    throw new Error(
      `runCompactionPipeline 收到未知的 deps 键：${unknown.join('、')}`
      + `（可用键：${COMPACTION_DEP_KEYS.join('、')}）——拼错的键名会被静默忽略，故直接拒绝。`
    );
  }
  return source;
}

// 四档编排（异步，依赖注入）。任一档解除压力（ratioOf < autoRatio）即短路。
// focus：本次压缩要特别保留什么（D 系 /compact <关注点>）；只影响 L2 的 system 提示词，
// 不传时逐字同旧版。宿主若已自行判定「该压了」，传 autoRatio=0 让四档全跑（档间不再自判）。
// deps:
//   estimateRatio(messages) -> number
//   persist(content, meta) -> Promise<{ path } | null>   （L0 修剪前的 O1 落盘）
//   clear(messages) -> Promise<{ messages, changed }>    （L1，宿主包 K1）
//   summarize(requestMessages) -> Promise<string>        （L2）
//   writeTranscript(jsonl) -> Promise<{ path } | null>   （L3）
//   retainTokens: number + estimateTokens(msg) -> number + minMessages: number
//     —— L2 尾部保留量（按 token 预算，minMessages 是下限条数）。**键名以本注释为准**：
//        宿主 buildSessionCompactionDeps 写的就是这三个名字（P0-4 之前这里读错过一个键，
//        见下面 L2 处的说明）。P2 的 assertCompactionDeps 会在收到未知键时直接抛。
export async function runCompactionPipeline(messages, { autoRatio = 0.8, focus = '', deps = {} } = {}) {
  const d = assertCompactionDeps(deps);
  const ratioOf = typeof d.estimateRatio === 'function' ? d.estimateRatio : () => 0;
  let current = Array.isArray(messages) ? messages : [];
  const applied = [];
  // L3 归档路径必须在**函数顶部**声明：它是本次压缩的产出之一（调用方要拿它显示/落库），
  // 而早期短路 return 与最终 return 都要带上它。2026-10-11 审查 P0-5：这里原先每个 return 都
  // 硬编码 `transcriptPath: ''`，L3 明明已写盘、路径也进了摘要正文，调用方（ChatPanel）却永远
  // 拿到空串——「归档了但没人知道在哪」。对照组 chat/reactiveCompact.js 的写法是对的。
  let transcriptPath = '';
  if (isCompactedHistory(current)) return { messages: current, applied, transcriptPath };
  if (ratioOf(current) < autoRatio) return { messages: current, applied, transcriptPath };

  // L0 修剪：先落盘（O1）再修剪；落盘失败保原文。
  if (typeof d.persist === 'function') {
    let changed = false;
    const next = [];
    for (const item of current) {
      if (item && item.role === 'tool' && messageTextOf(item).length > COMPACTION_TRIM_THRESHOLD_CHARS) {
        let stored = null;
        try { stored = await d.persist(messageTextOf(item), { toolCallId: item.tool_call_id, toolName: '' }); } catch (error) { stored = null; }
        if (stored && stored.path) {
          const content = messageTextOf(item);
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
      if (ratioOf(current) < autoRatio) return { messages: current, applied, transcriptPath };
    }
  }

  // L1 清除：宿主包 K1。
  if (typeof d.clear === 'function') {
    const cleared = await d.clear(current);
    if (cleared && cleared.changed && Array.isArray(cleared.messages)) {
      current = cleared.messages;
      applied.push('L1');
      if (ratioOf(current) < autoRatio) return { messages: current, applied, transcriptPath };
    }
  }

  // L2 摘要（+ L3 归档在破坏性替换前）。
  if (typeof d.summarize === 'function') {
    // ④：buildCompactionSummaryRequest 内部展开轨迹并自带工具转写（摘要看得到工具调用/结果）。
    // focus 仍透传（D 系 /compact <关注点>），只影响 L2 的 system 提示词。
    const request = buildCompactionSummaryRequest(current, { focus });
    const summary = String((await d.summarize(request)) || '').trim();
    if (summary) {
      applied.push('L2');
      // 赋值（不是重新声明）：transcriptPath 在函数顶部声明，最终 return 要把它带出去。
      if (typeof d.writeTranscript === 'function') {
        const stored = await d.writeTranscript(buildTranscriptJsonl(current));
        transcriptPath = stored && stored.path ? stored.path : '';
        if (transcriptPath) applied.push('L3');
      }
      current = applyCompactionWithAuthority(current, summary, {
        transcriptPath,
        retainTokens: d.retainTokens,
        // 键名与宿主（chat/sessionCompaction.js 的 buildSessionCompactionDeps）一致：`minMessages`。
        // 2026-10-11 审查 P0-4：这里原先读 `d.retainMinMessages`，而全仓**没有任何地方写这个键**
        // （宿主的保留下限一直叫 minMessages）→ 下限永远是 applyCompactionWithAuthority 的默认 6，
        // 「按 token 预算保留、下限 N 条」里的 N 静默失效。既有测试只断言 deps 里有 minMessages
        // 这个键，从没断言管线真的用了它，所以门禁全绿而 bug 在。
        minMessages: d.minMessages,
        estimateTokens: d.estimateTokens,
      });
    }
  }
  return { messages: current, applied, transcriptPath };
}
