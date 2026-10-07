// 记忆冲突检测：先用向量相似度挑出「说的是同一件事」的候选对，再让模型判定
// 这两条是否语义矛盾（如「喜欢猫」vs「讨厌猫」）。
//
// 为什么分两步：矛盾判定本质上需要语义理解，纯本地启发式（否定词表）在中文上
// 误报率极高，会把「不喜欢加班」和「不喜欢出差」也判成冲突。向量只用来把
// O(n²) 的候选收敛到少数几对，真正的判定交给模型一次批量完成。
//
// 本模块是纯逻辑（候选对 / 提示词 / 解析 / 合并），零 RN 依赖，Node 可直测；
// 发请求在 UI 层（复用既有 sendChatMessage）。

import { cosineSimilarity } from '../vectorMemory/index.js';
import { memoryKey } from './provenance.js';

// 候选门槛：低于此相似度的两条记忆不算「同一件事」，不送去判矛盾。
// 0.72 是经验值：覆盖「喜欢猫 / 讨厌猫」这类同主题不同态度的改写，
// 又不会把无关片段凑成对（无关片段余弦通常 < 0.5）。
export const CANDIDATE_MIN_SCORE = 0.72;

// 一次最多判定多少对：模型单次请求的输入预算有限，且判定结果要人工处理，
// 一次抛几十条冲突给用户没有意义。
export const MAX_CANDIDATE_PAIRS = 12;

// 单条记忆送进提示词的最大长度：索引分片本就不长（默认 400 字），
// 再截一刀是防御异常数据（历史 maxChars 调大过）撑爆请求。
export const MAX_PAIR_TEXT_CHARS = 240;

export const RESOLUTION_NONE = '';
export const RESOLUTION_KEPT_A = 'kept-a';
export const RESOLUTION_KEPT_B = 'kept-b';
export const RESOLUTION_MERGED = 'merged';
export const RESOLUTION_IGNORED = 'ignored';

// 一对记忆的稳定键：与传入顺序无关，保证「同一对」在扫描/存储/解析三处认得出。
export function conflictPairKey(left, right) {
  const a = typeof left === 'string' ? left : memoryKey(left);
  const b = typeof right === 'string' ? right : memoryKey(right);
  return [a, b].sort().join('\u0001');
}

function clipText(text, maxChars = MAX_PAIR_TEXT_CHARS) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.trunc(maxChars) : MAX_PAIR_TEXT_CHARS;
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

// 候选对：同一索引里语义最接近的记忆两两配对，按相似度降序。
// 三条硬规则避免制造噪声：
// 1) 同一条消息的不同分片（长消息被切开）天然高相似，不算冲突；
// 2) 文本完全相同的不算（重复索引）；
// 3) 已处理过（保留 / 忽略 / 合并）的对不再出现。
export function candidatePairs(index, options = {}) {
  const minScore = Number.isFinite(options.minScore) && options.minScore > 0
    ? Number(options.minScore)
    : CANDIDATE_MIN_SCORE;
  const limit = Number.isFinite(options.limit) && options.limit > 0
    ? Math.trunc(options.limit)
    : MAX_CANDIDATE_PAIRS;
  const excludeKeys = new Set(
    (Array.isArray(options.excludeKeys) ? options.excludeKeys : [])
      .map(key => String(key || ''))
      .filter(Boolean)
  );
  const items = (Array.isArray(index) ? index : []).filter(item => (
    item
    && Array.isArray(item.vector)
    && item.vector.length > 0
    && String(item.text || '').trim()
  ));
  const scored = [];
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const left = items[i];
      const right = items[j];
      const sameMessage = String(left.sessionId || '') === String(right.sessionId || '')
        && String(left.messageId || '') !== ''
        && String(left.messageId || '') === String(right.messageId || '');
      if (sameMessage) continue;
      if (String(left.text) === String(right.text)) continue;
      const key = conflictPairKey(left, right);
      if (excludeKeys.has(key)) continue;
      const score = cosineSimilarity(left.vector, right.vector);
      if (!Number.isFinite(score) || score < minScore) continue;
      scored.push({ key, score, left, right });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// 判定提示词。注意：这些中文是发给模型的指令，不是界面文案，不进 i18n 词条表
// （tests/i18n.test.mjs 会反向断言提示词不得出现在词条里）。
const CONFLICT_SYSTEM = [
  '你在帮用户核对长期记忆里是否有自相矛盾的地方。',
  '下面会给出若干组记忆（A、B 两条为一组，都是过去对话里提炼出来的片段）。',
  '',
  '请逐组判断：A 与 B 是否在事实上互相矛盾——即两者不可能同时为真。',
  '判断标准：',
  '- 只有「同一件事、同一个对象，结论相反或互斥」才算矛盾（例如先喜欢猫、后来讨厌猫）。',
  '- 话题相同但可以同时成立（例如「喜欢猫」与「养了一只叫豆豆的猫」）不算矛盾。',
  '- 只是时间上先后不同的状态变化，如果后一条明确取代了前一条，算矛盾；如果只是补充，不算。',
  '- 信息不足、无法判断时，按「不矛盾」处理。',
  '',
  '输出格式（每行一组，不要输出其它内容）：',
  '序号. 矛盾 或 不矛盾｜一句话理由',
  '例如：1. 矛盾｜对猫的喜好在后一条里被明确推翻。',
].join('\n');

export function buildConflictPrompt(pairs, options = {}) {
  const list = Array.isArray(pairs) ? pairs : [];
  const maxChars = options.maxChars;
  const lines = list.map((pair, index) => (
    `${index + 1}. A：${clipText(pair && pair.left && pair.left.text, maxChars)}\n`
    + `   B：${clipText(pair && pair.right && pair.right.text, maxChars)}`
  ));
  return [
    { role: 'system', content: CONFLICT_SYSTEM },
    { role: 'user', content: lines.join('\n') },
  ];
}

const CONTRADICTION_RE = /矛盾|冲突|contradict/i;
// 否定要贴着判定词才算：`两者不矛盾` 是「不矛盾」，而 `不认同 B，两者矛盾`
// 里的「不」离得远，不能把整句判反。
const NEGATED_RE = /(?:不|非|没有|无|未)\s*(?:矛盾|冲突)|not\s+contradict|no\s+contradiction/i;
const AFFIRM_RE = /^\s*(?:是|对|yes|true)/i;
const DENY_RE = /^\s*(?:否|不是|不对|no|false)/i;

// 解析模型的逐行判定。认不出的行不写结果（parsed:false），让上层跳过、
// 下次扫描还能重试——比猜一个默认值更诚实。
export function parseConflictResponse(text, pairs) {
  const list = Array.isArray(pairs) ? pairs : [];
  const byIndex = new Map();
  String(text || '').split('\n').forEach(line => {
    const match = line.match(/^\s*(\d+)\s*[.、)．:：]\s*(.+?)\s*$/);
    if (!match) return;
    const index = Number(match[1]) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= list.length) return;
    const body = match[2];
    let conflict;
    if (CONTRADICTION_RE.test(body)) {
      conflict = !NEGATED_RE.test(body);
    } else if (AFFIRM_RE.test(body)) {
      conflict = true;
    } else if (DENY_RE.test(body)) {
      conflict = false;
    } else {
      return;
    }
    byIndex.set(index, { conflict, reason: clipText(body, 120) });
  });
  return list.map((pair, index) => {
    const hit = byIndex.get(index);
    return {
      key: pair && pair.key ? pair.key : '',
      conflict: hit ? hit.conflict === true : false,
      reason: hit ? hit.reason : '',
      parsed: !!hit,
    };
  });
}

// 合并提示词：让模型把两条矛盾记忆合成一条「更新后的」记忆，保留状态变化。
const MERGE_SYSTEM = [
  '你会收到两条关于同一件事、但结论互相矛盾的记忆（A 与 B，B 通常更晚）。',
  '请把它们合并成一条更新后的记忆：',
  '- 以更晚的结论为准，但如果变化本身有意义（例如喜好发生了转变），要写出这个转变。',
  '- 只保留合并后的结论，不要罗列两条原文，也不要解释你的推理。',
  '- 写成一句或两句话，能独立看懂，写清涉及的对象。',
  '- 只输出这一条记忆的正文，不要加序号、项目符号或任何前缀。',
].join('\n');

export function buildMergePrompt(left, right, options = {}) {
  const maxChars = options.maxChars;
  const leftText = clipText(left && left.text, maxChars);
  const rightText = clipText(right && right.text, maxChars);
  return [
    { role: 'system', content: MERGE_SYSTEM },
    { role: 'user', content: `A：${leftText}\nB：${rightText}` },
  ];
}

// 解析合并结果：只取第一条有效行，剥掉模型爱加的列表符与前缀词。
export function parseMergeResponse(text) {
  const lines = String(text || '')
    .split('\n')
    .map(line => line
      .replace(/^[-*•]\s*/, '')
      .replace(/^(?:合并后|合并结果|merged)\s*[:：]\s*/i, '')
      .trim())
    .filter(Boolean);
  return lines.length > 0 ? lines[0] : '';
}

// 列表徽标用：memoryKey → 该记忆参与的未处理矛盾对。
export function conflictIndex(records) {
  const map = new Map();
  (Array.isArray(records) ? records : []).forEach(record => {
    if (!record || record.conflict !== true || record.resolution) return;
    [record.aKey, record.bKey].forEach(key => {
      const value = String(key || '');
      if (!value) return;
      if (!map.has(value)) map.set(value, []);
      map.get(value).push(record);
    });
  });
  return map;
}

export function pendingConflicts(records) {
  return (Array.isArray(records) ? records : []).filter(record => (
    record && record.conflict === true && !record.resolution
  ));
}

// 已经判过的对键（不论结论是矛盾还是无关），供下次扫描排除。
// 排除「已判定为无关」的对是刻意的：判定要花一次模型调用，同一对记忆的文本
// 不会自己变，反复重判只是白花钱。
export function judgedPairKeys(records) {
  return (Array.isArray(records) ? records : [])
    .filter(record => record && record.key)
    .map(record => String(record.key));
}
