// 向量索引的**编码与分片**（纯函数，零原生依赖，Node 可直测）。
//
// 为什么需要这一层：整条向量索引（每条记忆一个 embedding）此前塞在**单个** AsyncStorage
// 键里，实测（Node 基准，1024 维）——
//   200 条 ≈ 4.0 MB   1000 条 ≈ 19.8 MB（stringify 145ms、parse 71ms）  3000 条 ≈ 59.4 MB（stringify 444ms）
// 三个后果：
//   ① 单值越过 Android CursorWindow 约 2MB 的读取上限 ⇒ 每次读都要走 storage/io.js 的
//      SQLite 分块兜底（20MB = 80 次 execAsync）；
//   ② 任何一次写入都要重新 JSON.stringify 整条索引（O(条数×维度)）；
//   ③ 数字以 JSON 文本存：一个 float 最多 20 字符，1024 维就是约 20KB/条，其中绝大部分
//      是「0.012345678901234567」这种十进制展开——纯浪费。
//
// 本模块负责两件事：
//   ① **分片**：分段键稳定散列到 N 片，每片一个键。写入只需碰改动到的那几片，
//      每片也远小于 2MB（不再触发分块兜底读）。
//   ② **紧凑编码**：Float32Array + base64（每维 4 字节 → 约 5.5KB/1024 维，比 JSON 小约 3.6 倍）。
//      代价是 float64 → float32 的精度损失（约 7 位有效数字）：embedding 只用于余弦
//      相似度排序，这个量级的误差不改变排序结果；且所有既有测试用的是整数向量，
//      往返逐位相等。见 tests/vectorIndexLayout.test.mjs 的往返用例。

// 分片数。取值权衡：片越小写越便宜，但读取要按片各取一次（检索需要全部向量）。
// 32 片下 1024 维的典型体积——1000 条 ≈ 31 条/片 ≈ 170KB，3000 条 ≈ 94 条/片 ≈ 520KB，
// 都在单值预算（io.js VALUE_BUDGET_BYTES = 1.5MB）与 CursorWindow 上限之内。
export const VECTOR_SHARD_COUNT = 32;

export const VECTOR_SHARD_PREFIX = '@easychat2_vector_shard';

export function vectorShardKey(characterId, shard) {
  const id = String(characterId || '');
  if (!id) return '';
  return `${VECTOR_SHARD_PREFIX}::${id}::${String(shard)}`;
}

// vectorShardKey 的**逆运算**：从任意键名解析出 { characterId, shard }，不是分片键返回 null。
//
// 为什么需要它（M3：孤儿分片残留 = 隐私问题）：
// 分片键此前**没有任何反向解析入口**，于是两处扫描都看不见它们：
//   · 快速导出按前缀白名单挑键（dataBackup.js 的 QUICK_EXPORT_PREFIXES），分片键不在其中；
//   · 向量对账只扫 `@easychat2_vector_index::` 元数据键，分片键完全不在视野内。
// 后果：清空向量记忆/删角色若中途失败，分片会永久留在盘上——用户以为「记忆已删干净」，
// 而整份 embedding（可还原出原文语义）仍在。这是隐私残留，不是单纯的垃圾数据。
//
// 角色 id 本身可能含 '::'（历史数据里没有，但不能假设），所以**从右往左**找最后一个
// '::' 作为 id 与片号的分界。
export function parseVectorShardKey(key) {
  const text = String(key || '');
  const prefix = `${VECTOR_SHARD_PREFIX}::`;
  if (!text.startsWith(prefix)) return null;
  const rest = text.slice(prefix.length);
  const splitAt = rest.lastIndexOf('::');
  if (splitAt <= 0) return null;
  const characterId = rest.slice(0, splitAt);
  const shardText = rest.slice(splitAt + 2);
  if (!characterId) return null;
  // 片号必须是 0..VECTOR_SHARD_COUNT-1 的整数；否则不是本模块写的键（或已损坏），
  // 一律当作「不认识」而不是猜一个片号出来——猜错会导致误删别人的分片。
  if (!/^\d+$/.test(shardText)) return null;
  const shard = Number(shardText);
  if (!Number.isInteger(shard) || shard < 0 || shard >= VECTOR_SHARD_COUNT) return null;
  return { characterId, shard };
}

// 稳定分片：同一个分段键**永远**落在同一片。这条是「只重写改动到的片」的前提——
// 若分片随下标/顺序变化，每次都只能全量重写，分片就白分了。
// 用 FNV-1a 32 位（纯整数运算，Hermes 与 Node 结果一致），不用 Object.hashCode 之类
// 各引擎实现不同的东西。
export function vectorShardIndex(segmentKey, count = VECTOR_SHARD_COUNT) {
  const text = String(segmentKey || '');
  const total = Number.isFinite(count) && count > 0 ? Math.floor(count) : 1;
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % total;
}

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_LOOKUP = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < BASE64_CHARS.length; i += 1) table[BASE64_CHARS.charCodeAt(i)] = i;
  return table;
})();

// 向量 → base64（Float32，小端，无填充）。空/非法输入一律返回 ''：调用方据此把这条
// 当作「没有向量」处理（随后会被重新嵌入），而不是拿到一串垃圾。
export function encodeVector(vector) {
  const list = Array.isArray(vector) ? vector : [];
  if (list.length === 0) return '';
  const floats = new Float32Array(list.length);
  for (let i = 0; i < list.length; i += 1) {
    const value = Number(list[i]);
    floats[i] = Number.isFinite(value) ? value : 0;
  }
  const bytes = new Uint8Array(floats.buffer, floats.byteOffset, floats.byteLength);
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += BASE64_CHARS[b0 >> 2];
    out += BASE64_CHARS[((b0 & 3) << 4) | (b1 >> 4)];
    if (i + 1 < bytes.length) out += BASE64_CHARS[((b1 & 15) << 2) | (b2 >> 6)];
    if (i + 2 < bytes.length) out += BASE64_CHARS[b2 & 63];
  }
  return out;
}

// base64 → 向量（number[]，与旧布局读出来的形状一致，调用方无需区分）。
// 字符数 → 字节数：每 4 个字符 3 字节，余 2 字符 1 字节、余 3 字符 2 字节；
// 无填充时 floor(字符数 × 3 / 4) 恰好等于原字节数（三种余数都成立）。
export function decodeVector(packed) {
  if (typeof packed !== 'string' || packed.length < 2) return [];
  const byteCount = Math.floor((packed.length * 3) / 4);
  const floatCount = Math.floor(byteCount / 4);
  if (floatCount <= 0) return [];
  const bytes = new Uint8Array(floatCount * 4);
  let out = 0;
  for (let i = 0; i < packed.length && out < bytes.length; i += 4) {
    const c0 = charAt(packed, i);
    const c1 = charAt(packed, i + 1);
    if (c0 < 0 || c1 < 0) return [];
    const c2 = charAt(packed, i + 2);
    const c3 = charAt(packed, i + 3);
    if (out < bytes.length) bytes[out++] = (c0 << 2) | (c1 >> 4);
    if (c2 >= 0 && out < bytes.length) bytes[out++] = ((c1 & 15) << 4) | (c2 >> 2);
    if (c3 >= 0 && out < bytes.length) bytes[out++] = ((c2 & 3) << 6) | c3;
  }
  const floats = new Float32Array(bytes.buffer, bytes.byteOffset, floatCount);
  const list = new Array(floatCount);
  for (let i = 0; i < floatCount; i += 1) list[i] = floats[i];
  return list;
}

function charAt(text, index) {
  if (index >= text.length) return -1;
  const code = text.charCodeAt(index);
  return code < 128 ? BASE64_LOOKUP[code] : -1;
}
