// 主聊天页的会话压缩宿主（N2 四档管线的接线层）。
//
// 两件事，放一起是因为它们只服务于同一个调用点：
//   buildSessionCompactionDeps：把工作区 store / 工具结果落盘 / K1 清除 / token 估算
//     接成管线 deps。**没有工作区后端就不注入 persist/clear/writeTranscript**——对应档
//     自然空转，绝不出现「写不进去却假装修剪了」（applyResultClearing 本身也拒绝写假指针）。
//   runSessionCompaction：跑一次管线并把结果收成判别式 { ok, messages, applied } /
//     { ok:false, reason }。宿主（ChatScreen）只负责弹窗与替换消息，判定逻辑留在这里可直测。
//
// 触发判定不在这里：本页由 useAutoCompact（token 预算 + 字节双规则）或手动按钮决定
// 「该压了」，所以管线传 autoRatio=0——不重复判一次，避免字节触发却被 token 口径短路。
//
// 与 loop 内 K1 的关系：clear 用的就是同一套判定（planResultClearing 的预算 + 未见保护 +
// 配对自检），不是第二套实现。

import {
  COMPACTION_KEEP_RECENT,
  COMPACTION_RETAIN_RATIO,
  normalizeCompactionFocus,
} from './compaction.js';
import { runCompactionPipeline } from './compactionPipeline.js';
import { computeContextUsage } from './contextUsage.js';
import { estimateMessagesTokens } from '../localModel/localContext.js';
import {
  RESULT_CLEARING_BUDGET_BYTES,
  applyResultClearing,
  planResultClearing,
} from '../agent/resultClearing.js';
import { persistToolResult } from '../workspace/taskOutputs.js';
import { writeTranscript } from '../workspace/transcripts.js';
import { collectCompactionHooks, readWorkspaceHooks } from '../workspace/hooks.js';

// 惰性加载（照 workspace/native.js 的写法）：storage/io.js 顶层静态 import expo-file-system，
// Node 测试环境直接 import 会抛；宿主已持有 store 时可注入 loadStore 绕开这条链。
function defaultLoadStore() {
  try {
    const { createWorkspaceStore } = require('../workspace/native.js');
    const { getWorkspaceSettings } = require('../storage/workspace.js');
    return Promise.resolve(getWorkspaceSettings()).then(settings => createWorkspaceStore(settings));
  } catch (error) {
    return Promise.resolve(null);
  }
}

// P0-8：压缩前钩子——`deny` 拦下这次压缩，`inject` 并进「额外要求」（与关注点同一条通道）。
// 钩子读失败一律当没有钩子（声明式扩展不该成为压缩链路的故障源），store 为 null 时
// 调用方拿到的 deps 自然不含落盘/归档能力。
export async function resolveCompactionFocus({ characterId = '', focus = '', loadStore = defaultLoadStore } = {}) {
  let store = null;
  try {
    store = await loadStore();
    const compactHooks = collectCompactionHooks(await readWorkspaceHooks(store, characterId), focus);
    if (compactHooks.blocks.length > 0) return { blocked: compactHooks.blocks, store, focus };
    return {
      blocked: [],
      store,
      focus: normalizeCompactionFocus([focus, ...compactHooks.notices].filter(Boolean).join('；')),
    };
  } catch (error) {
    return { blocked: [], store, focus };
  }
}

export function buildSessionCompactionDeps({
  windowSize = 0,
  store = null,
  characterId = '',
  summarize = null,
} = {}) {
  const size = Math.max(0, Number(windowSize) || 0);
  const deps = {
    // 档间短路判据（本页 autoRatio=0，宿主已决定要压，这里只用于档与档之间比较）。
    estimateRatio: messages => {
      const usage = computeContextUsage(messages, size);
      return usage && Number.isFinite(usage.ratio) ? usage.ratio : 0;
    },
    // P4：尾部保留量按 token 预算（窗口的 16%），下限仍是 6 条。
    retainTokens: Math.max(0, Math.floor(size * COMPACTION_RETAIN_RATIO)),
    minMessages: COMPACTION_KEEP_RECENT,
    estimateTokens: message => estimateMessagesTokens([{
      role: message && message.role,
      content: String((message && (message.content != null ? message.content : message.text)) || ''),
    }]),
  };
  if (typeof summarize === 'function') deps.summarize = summarize;
  if (store) {
    deps.persist = (content, meta) => persistToolResult({
      store,
      characterId,
      toolUseId: meta && meta.toolCallId,
      content,
    });
    // L1：与 loop 的 K1 同一套判定；无落盘能力时 applyResultClearing 原样返回（changed=false）。
    deps.clear = async messages => {
      const plan = planResultClearing(messages, { budgetBytes: RESULT_CLEARING_BUDGET_BYTES });
      const cleared = await applyResultClearing(messages, plan.indices, { persist: deps.persist });
      return { messages: cleared.messages, changed: cleared.cleared.length > 0 };
    };
    deps.writeTranscript = jsonl => writeTranscript({ store, characterId, content: jsonl });
  }
  return deps;
}

// 反应式压缩（上下文超限 → 摘要旧史 + 重试一次）的 deps。与四档管线同一条纪律：
// 没有工作区后端就不注入 writeTranscript——破坏性替换前先归档，归档不了就只留摘要，
// 绝不写假指针。summarize 由宿主给（要带 config 指纹）。
export function buildReactiveCompactDeps({ store = null, characterId = '', summarize = null } = {}) {
  const deps = {};
  if (typeof summarize === 'function') deps.summarize = summarize;
  if (store) deps.writeTranscript = jsonl => writeTranscript({ store, characterId, content: jsonl });
  return deps;
}

// 计入压缩判据的「有内容」消息数（user/assistant 且正文非空）——与 COMPACTION_MIN_MESSAGES
// 同口径，宿主用它决定「太短不压」。
export function countCompactionMessages(list) {
  return (Array.isArray(list) ? list : []).filter(item => item
    && (item.role === 'user' || item.role === 'assistant')
    && String((item && (item.text || item.content)) || '').trim()).length;
}

export async function runSessionCompaction({
  list,
  focus = '',
  windowSize = 0,
  store = null,
  characterId = '',
  summarize = null,
  emptyReplyText = '',
} = {}) {
  const messages = Array.isArray(list) ? list : [];
  // 端点把「空回复」兜成占位文案（network/api.js 的 EMPTY_REPLY_TEXT）——那不是摘要，
  // 直接当空处理，避免把占位文案写进历史。
  const ask = typeof summarize === 'function'
    ? async request => {
      const reply = String((await summarize(request)) || '').trim();
      return !reply || reply === emptyReplyText ? '' : reply;
    }
    : null;
  const result = await runCompactionPipeline(messages, {
    autoRatio: 0,
    focus,
    deps: buildSessionCompactionDeps({ windowSize, store, characterId, summarize: ask }),
  });
  // 四档全空转（历史已是压缩产物 / 摘要为空）→ 不动会话，如实报 noop。
  if (result.applied.length === 0 || result.messages === messages) return { ok: false, reason: 'noop' };
  return { ok: true, messages: result.messages, applied: result.applied };
}
