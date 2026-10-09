// 本会话统计（纯函数，Node 直测）：累计 token、请求数、按 API 配置分组、生成速度。
//
// 数据从请求链路顺手采集（useChatSend 在每次回复请求前后打点），口径如实标注：
// - token 是**估算**：在线 API 不返回 usage，sendChatMessage 只回文本；这里复用项目
//   统一的估算器（localModel/localContext 的 estimateTextTokens / estimateMessagesTokens，
//   CJK 约 1 token/字、其余 4 字符/token），所以不同服务商之间**口径一致、可比**，
//   但不要当精确计费数字用；
// - 首字延迟 = 请求发出 → 第一个流式增量到达（非流式请求没有首字概念，不计入样本）；
// - 速度 = completionTokens / 生成时长（首字之后到结束），聚合时用总量相除，
//   比逐条平均更稳（避免短回复把速度拉飞）。

import { estimateMessageTokens, estimateMessagesTokens } from '../localModel/localContext.js';

export const SESSION_STATS_VERSION = 1;
// 单个会话最多保留多少个 API 配置分组（超出按请求数保留前 N，其余合并进「其他」）。
export const MAX_STATS_GROUPS = 20;
export const OTHER_GROUP_KEY = '__other__';

export function estimatePromptTokens(messages) {
  return estimateMessagesTokens(messages);
}

export function estimateReplyTokens(text) {
  return estimateMessageTokens({ role: 'assistant', content: String(text || '') });
}

export function createEmptyStats() {
  return {
    version: SESSION_STATS_VERSION,
    requests: 0,
    failedRequests: 0,
    promptTokens: 0,
    completionTokens: 0,
    // E1：缓存命中的 prompt token 数（端点返回 usage 时才有）——命中率 = 它 / promptTokens。
    cachedTokens: 0,
    firstTokenMsSum: 0,
    firstTokenSamples: 0,
    generationMsSum: 0,
    groups: {},
    firstAt: 0,
    lastAt: 0,
  };
}

function toCount(value) {
  const num = Math.floor(Number(value));
  return Number.isFinite(num) && num > 0 ? num : 0;
}

function normalizeGroup(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    label: String(source.label || ''),
    model: String(source.model || ''),
    requests: toCount(source.requests),
    failedRequests: toCount(source.failedRequests),
    promptTokens: toCount(source.promptTokens),
    completionTokens: toCount(source.completionTokens),
    cachedTokens: toCount(source.cachedTokens),
    firstTokenMsSum: toCount(source.firstTokenMsSum),
    firstTokenSamples: toCount(source.firstTokenSamples),
    generationMsSum: toCount(source.generationMsSum),
  };
}

// 从存储读回时防御性归一（坏数据不能把面板算崩）。
export function normalizeStats(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const groups = {};
  const rawGroups = source.groups && typeof source.groups === 'object' && !Array.isArray(source.groups)
    ? source.groups
    : {};
  Object.entries(rawGroups).forEach(([key, value]) => {
    const id = String(key || '').trim();
    if (!id) return;
    groups[id] = normalizeGroup(value);
  });
  return {
    version: SESSION_STATS_VERSION,
    requests: toCount(source.requests),
    failedRequests: toCount(source.failedRequests),
    promptTokens: toCount(source.promptTokens),
    completionTokens: toCount(source.completionTokens),
    cachedTokens: toCount(source.cachedTokens),
    firstTokenMsSum: toCount(source.firstTokenMsSum),
    firstTokenSamples: toCount(source.firstTokenSamples),
    generationMsSum: toCount(source.generationMsSum),
    groups,
    firstAt: toCount(source.firstAt),
    lastAt: toCount(source.lastAt),
  };
}

// 一次请求的计时器：请求发出 → 首字 → 结束。
// now 可注入（测试用假时钟，避免依赖真实时间）。
export function createRequestMeter(now = () => Date.now()) {
  const startedAt = now();
  let firstTokenAt = 0;
  let finishedAt = 0;
  return {
    startedAt,
    markFirstToken() {
      if (!firstTokenAt) firstTokenAt = now();
    },
    finish() {
      finishedAt = now();
      return {
        startedAt,
        firstTokenAt,
        finishedAt,
        firstTokenMs: firstTokenAt ? firstTokenAt - startedAt : 0,
        // 非流式（没有首字）时按整段耗时算生成时长，速度口径仍然成立。
        generationMs: (firstTokenAt ? finishedAt - firstTokenAt : finishedAt - startedAt),
      };
    },
  };
}

// 记一次请求。返回新的 stats（不改原对象）。
// entry: { configId, configLabel, model, promptTokens, completionTokens, firstTokenMs, generationMs, failed, at }
export function recordRequest(stats, entry = {}) {
  const base = normalizeStats(stats);
  const source = entry && typeof entry === 'object' ? entry : {};
  const at = toCount(source.at) || Date.now();
  const promptTokens = toCount(source.promptTokens);
  const completionTokens = toCount(source.completionTokens);
  const cachedTokens = toCount(source.cachedTokens);
  const firstTokenMs = toCount(source.firstTokenMs);
  const generationMs = toCount(source.generationMs);
  const failed = source.failed === true;

  const next = {
    ...base,
    groups: { ...base.groups },
    requests: base.requests + 1,
    failedRequests: base.failedRequests + (failed ? 1 : 0),
    promptTokens: base.promptTokens + promptTokens,
    completionTokens: base.completionTokens + completionTokens,
    cachedTokens: base.cachedTokens + cachedTokens,
    firstTokenMsSum: base.firstTokenMsSum + (firstTokenMs > 0 ? firstTokenMs : 0),
    firstTokenSamples: base.firstTokenSamples + (firstTokenMs > 0 ? 1 : 0),
    generationMsSum: base.generationMsSum + generationMs,
    firstAt: base.firstAt || at,
    lastAt: at,
  };

  const key = String(source.configId || '').trim() || 'unknown';
  const group = normalizeGroup(next.groups[key]);
  next.groups[key] = {
    ...group,
    label: String(source.configLabel || group.label || ''),
    model: String(source.model || group.model || ''),
    requests: group.requests + 1,
    failedRequests: group.failedRequests + (failed ? 1 : 0),
    promptTokens: group.promptTokens + promptTokens,
    completionTokens: group.completionTokens + completionTokens,
    cachedTokens: group.cachedTokens + cachedTokens,
    firstTokenMsSum: group.firstTokenMsSum + (firstTokenMs > 0 ? firstTokenMs : 0),
    firstTokenSamples: group.firstTokenSamples + (firstTokenMs > 0 ? 1 : 0),
    generationMsSum: group.generationMsSum + generationMs,
  };

  // 分组上限：按请求数保留前 N，其余归并进「其他」，避免长会话把存储撑大。
  const keys = Object.keys(next.groups);
  if (keys.length > MAX_STATS_GROUPS) {
    const sorted = keys.sort((a, b) => next.groups[b].requests - next.groups[a].requests);
    const keep = new Set(sorted.slice(0, MAX_STATS_GROUPS - 1));
    const other = normalizeGroup(next.groups[OTHER_GROUP_KEY]);
    const merged = { ...next.groups };
    sorted.forEach(id => {
      if (keep.has(id)) return;
      const group = merged[id];
      other.requests += group.requests;
      other.failedRequests += group.failedRequests;
      other.promptTokens += group.promptTokens;
      other.completionTokens += group.completionTokens;
      other.cachedTokens += group.cachedTokens;
      other.firstTokenMsSum += group.firstTokenMsSum;
      other.firstTokenSamples += group.firstTokenSamples;
      other.generationMsSum += group.generationMsSum;
      delete merged[id];
    });
    merged[OTHER_GROUP_KEY] = other;
    next.groups = merged;
  }
  return next;
}

function tokensPerSec(completionTokens, generationMs) {
  if (!completionTokens || !generationMs) return 0;
  return completionTokens / (generationMs / 1000);
}

// 汇总成面板可直接渲染的结构（分组按请求数从多到少）。
export function summarizeStats(stats) {
  const base = normalizeStats(stats);
  const totalTokens = base.promptTokens + base.completionTokens;
  const groups = Object.entries(base.groups)
    .map(([key, group]) => ({
      key,
      label: group.label || key,
      model: group.model,
      requests: group.requests,
      failedRequests: group.failedRequests,
      totalTokens: group.promptTokens + group.completionTokens,
      cachedTokens: group.cachedTokens,
      cacheHitRate: group.promptTokens > 0 ? group.cachedTokens / group.promptTokens : 0,
      avgFirstTokenMs: group.firstTokenSamples
        ? Math.round(group.firstTokenMsSum / group.firstTokenSamples)
        : 0,
      tokensPerSec: tokensPerSec(group.completionTokens, group.generationMsSum),
      share: totalTokens > 0
        ? (group.promptTokens + group.completionTokens) / totalTokens
        : 0,
    }))
    .sort((a, b) => (b.requests - a.requests) || (b.totalTokens - a.totalTokens));
  return {
    requests: base.requests,
    failedRequests: base.failedRequests,
    promptTokens: base.promptTokens,
    completionTokens: base.completionTokens,
    cachedTokens: base.cachedTokens,
    // E1 缓存命中率：口径已统一为 prompt ⊇ cached（见 api.extractUsage）。
    // 端点不返回 usage 的会话恒为 0——显示层据此决定是否展示这一行。
    cacheHitRate: base.promptTokens > 0 ? base.cachedTokens / base.promptTokens : 0,
    totalTokens,
    avgFirstTokenMs: base.firstTokenSamples
      ? Math.round(base.firstTokenMsSum / base.firstTokenSamples)
      : 0,
    tokensPerSec: tokensPerSec(base.completionTokens, base.generationMsSum),
    firstAt: base.firstAt,
    lastAt: base.lastAt,
    groups,
  };
}
