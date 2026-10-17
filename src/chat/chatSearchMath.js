// 聊天内搜索的纯逻辑：匹配消息与循环推进匹配下标。从 useChatSearch 抽出便于单测。

import { getMessagePromptText } from './chatMedia.js';
import { ASSISTANT_ID, USER_ID } from './chatConstants.js';

// 空结果用**模块级冻结常量**，不是每次新建 `[]`：
// useChatSearch 里 searchMatches 会被 join 成签名、进 useEffect 依赖，
// 每 tick 新建空数组会让「搜索关闭」这条路径也逐帧重跑下游（参见 scrubberPreviews 的修法）。
export const NO_MATCHES = Object.freeze([]);

// 逐条匹配缓存（WeakMap，键是消息对象引用）。与 useScrollScrubber.js 的 buildScrubberPreview、
// compaction.js 的 createMessageBytesEstimator 同构：**抄结构，不发明新形状**。
//
// 为什么需要它（2026-10-17 实测，2000 条 × 300 字中文历史）：
//   修复前 collectSearchMatchIds 每 tick 对**全历史**重跑 getMessagePromptText + toLowerCase
//   + includes：1.18 ms/tick。而流式期间每 tick 只有尾部一条是新引用，其余全都没变。
//   按引用缓存后降到 0.06 ms/tick（5.3%）；搜索关闭时直接短路到 0.001 ms。
//
// 失效条件只有 needle：query 一变，所有条目的判定都得重来（缓存项里比对 needle）。
// 不设「清空定时器」之类的回收：消息对象是短命引用，WeakMap 自然回收（任务书明确要求）。
const matchCache = new WeakMap();

function matchesOne(message, needle) {
  const cached = matchCache.get(message);
  if (cached && cached.needle === needle) return cached.hit;
  const hit = !!message
    && (message.role === USER_ID || message.role === ASSISTANT_ID)
    && getMessagePromptText(message).toLowerCase().includes(needle);
  matchCache.set(message, { needle, hit });
  return hit;
}

// 命中消息的 id 列表（保持消息顺序）。query 去空白并小写，空查询返回空数组。
//
// active 参数：搜索面板是否打开。关闭时**直接返回 NO_MATCHES 且不扫**——这是本函数的
// 主要收益来源（用户在聊天时绝大多数时间搜索是关的，此前那条路径照样全历史扫描）。
// 默认 true 保持既有调用方（测试/其它入口）语义不变。
export function collectSearchMatchIds(messages, query, active = true) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return NO_MATCHES;
  if (!active) return NO_MATCHES;
  const list = Array.isArray(messages) ? messages : [];
  if (list.length === 0) return NO_MATCHES;
  const hits = [];
  for (const message of list) {
    if (matchesOne(message, needle)) hits.push(message.id);
  }
  // 无命中时返回同一个冻结常量：下游 join / 依赖比较因此不再逐帧变化。
  return hits.length === 0 ? NO_MATCHES : hits;
}

// 在命中列表里按 delta 循环推进下标：到底回到头，到头回到尾。
export function advanceMatchIndex(activeMatchIndex, delta, matchCount) {
  if (!Number.isFinite(matchCount) || matchCount <= 0) return 0;
  const current = Math.trunc(Number(activeMatchIndex)) || 0;
  const step = Math.trunc(Number(delta)) || 0;
  return ((current + step) % matchCount + matchCount) % matchCount;
}
