// N1：reactive 回退——API 报「上下文超限」时，归档 → 尾 5 保留（配对回退）→ 摘要旧史 → 重试一次。
//
// 教材 reactive_compact 的真髓：**不是「回退 5 条」而是「尾部 5 条原文保留、旧史摘要化」**，
// 信息只移不丢；重试一次（MAX_REACTIVE_RETRIES=1）。本模块提供共享核心纯函数，两个挂载点
// （工作区 loop 轮次 + 聊天页发送路径）复用；重试一次由调用方控制。
//
// 摘要提示词与「权威分离」格式复用 N2/D3（compaction.js / compactionPipeline.js）。

import { buildCompactionSummaryRequest } from './compaction.js';
import {
  applyCompactionWithAuthority,
  buildToolTranscript,
  buildTranscriptJsonl,
} from './compactionPipeline.js';

export const REACTIVE_KEEP_RECENT = 5;
export const REACTIVE_FAILED_MESSAGE = '上下文超限，已尝试自动压缩仍失败，请手动压缩或精简会话。';

// 错误矩阵：code/type 或 message 命中任一子串即判为上下文超限（大小写不敏感）。
export const CONTEXT_OVERFLOW_CODES = Object.freeze([
  'context_length_exceeded',
  'context_length_exceeded_error',
  'prompt_too_long',
  'string_above_max_length',
  'too_many_tokens',
  'max_tokens_exceeded',
  'input_too_long',
]);

export const CONTEXT_OVERFLOW_MESSAGES = Object.freeze([
  'context length',
  'context_length',
  'context window',
  'maximum context',
  'max context',
  'too many tokens',
  'reduce the length',
  'prompt is too long',
  'input is too long',
  'exceeds the maximum',
  'exceed context',
  'context limit',
]);

export function isContextOverflowError(error) {
  if (!error) return false;
  const code = String(error.code || error.type || '').toLowerCase();
  if (code && CONTEXT_OVERFLOW_CODES.some(sig => code.includes(sig))) return true;
  const message = String(error.message || '').toLowerCase();
  if (message && CONTEXT_OVERFLOW_MESSAGES.some(sig => message.includes(sig))) return true;
  return false;
}

// 单次机会编排：命中矩阵 → （写 transcript 归档）→ 摘要旧史 → 尾 5 保留（配对回退）。
// deps: { summarize(requestMessages) -> Promise<string>, writeTranscript(jsonl) -> Promise<{ path }|null> }
// 返回 { compacted, messages, transcriptPath }。调用方据此决定是否重试一次。
export async function runReactiveCompact({ messages, error, deps = {} } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  if (!isContextOverflowError(error)) return { compacted: false, messages: list, transcriptPath: '' };
  if (typeof deps.summarize !== 'function') return { compacted: false, messages: list, transcriptPath: '' };

  let transcriptPath = '';
  if (typeof deps.writeTranscript === 'function') {
    try {
      const stored = await deps.writeTranscript(buildTranscriptJsonl(list));
      transcriptPath = stored && stored.path ? stored.path : '';
    } catch (error2) {
      transcriptPath = '';
    }
  }

  const request = buildCompactionSummaryRequest(list, { toolTranscript: buildToolTranscript(list) });
  const summary = String((await deps.summarize(request)) || '').trim();
  if (!summary) return { compacted: false, messages: list, transcriptPath };

  const next = applyCompactionWithAuthority(list, summary, { keep: REACTIVE_KEEP_RECENT, transcriptPath });
  return { compacted: true, messages: next, transcriptPath };
}
