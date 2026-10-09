// C3 批量单提交回推：本地副本 → 远程一次原子提交（Trees API 四步 + 父提交查询）。
//
// 为什么不是逐文件 contents API：50 个文件 = 50 次 PUT + 50 个提交（历史碎、
// 限流风险高）。Trees API 一把构造新树 → 一个 commit → 一次 ref 更新，历史干净，
// 且天然支持删除（sha: null 条目）。
//
// 内容改动的判据是 **git blob sha**（'blob <len>\0' + 内容的 SHA-1）——与远程
// tree 条目的 sha 同一口径，本地算、远程比，不必拉远程内容。
//
// 纯函数（SHA-1 / blob sha / base64 / 三态 diff）与 IO 组合分层，Node 直测。
import { strToU8 } from 'fflate';

import {
  createBlob,
  createCommit,
  createTree,
  getRef,
  listTree,
  updateRef,
} from './github/restApi.js';

// —— SHA-1（RFC 3174 纯实现）——
// Hermes 没有 crypto：git blob sha 必须自己算（本地 vs 远程 diff 的判据）。
function rotl(value, bits) {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

export function sha1Hex(input) {
  const data = input instanceof Uint8Array ? input : new Uint8Array(input || []);
  const bitLength = data.length * 8;
  const padded = new Uint8Array((((data.length + 8) >> 6) + 1) << 6);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000), false);
  view.setUint32(padded.length - 4, bitLength >>> 0, false);

  let h0 = 0x67452301;
  let h1 = 0xEFCDAB89;
  let h2 = 0x98BADCFE;
  let h3 = 0x10325476;
  let h4 = 0xC3D2E1F0;
  const w = new Uint32Array(80);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 80; i += 1) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let i = 0; i < 80; i += 1) {
      let f;
      let k;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5A827999; } else if (i < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; } else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; } else { f = b ^ c ^ d; k = 0xCA62C1D6; }
      const temp = (rotl(a, 5) + f + e + k + w[i]) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = temp;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4].map(value => value.toString(16).padStart(8, '0')).join('');
}

// git blob sha：'blob <字节数>\0' + 内容 的 SHA-1——与 GitHub tree 条目同口径。
export function computeGitBlobSha(text) {
  const content = strToU8(String(text == null ? '' : text));
  const header = strToU8(`blob ${content.length}\0`);
  const combined = new Uint8Array(header.length + content.length);
  combined.set(header);
  combined.set(content, header.length);
  return sha1Hex(combined);
}

// 字节数组 → base64（手写，与 repoMaterialize.base64ToBytes 对称；Hermes 不保证 btoa）。
export function bytesToBase64(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const data = input instanceof Uint8Array ? input : new Uint8Array(input || []);
  let out = '';
  for (let i = 0; i < data.length; i += 3) {
    const b0 = data[i];
    const b1 = data[i + 1];
    const b2 = data[i + 2];
    out += alphabet[b0 >> 2];
    out += alphabet[((b0 & 0x03) << 4) | ((b1 === undefined ? 0 : b1) >> 4)];
    out += b1 === undefined ? '=' : alphabet[((b1 & 0x0f) << 2) | ((b2 === undefined ? 0 : b2) >> 6)];
    out += b2 === undefined ? '=' : alphabet[b2 & 0x3f];
  }
  return out;
}

// 纯函数：本地（含 blob sha）vs 远程 tree → 三态差。
export function diffRemoteLocal({ localFiles, remoteEntries } = {}) {
  const remoteMap = new Map(
    (Array.isArray(remoteEntries) ? remoteEntries : [])
      .filter(item => item && item.type === 'blob' && item.path)
      .map(item => [item.path, item.sha])
  );
  const localMap = new Map(
    (Array.isArray(localFiles) ? localFiles : [])
      .filter(item => item && item.path)
      .map(item => [item.path, item.sha])
  );
  const added = [...localMap.keys()].filter(path => !remoteMap.has(path)).sort();
  const modified = [...localMap.keys()]
    .filter(path => remoteMap.has(path) && remoteMap.get(path) !== localMap.get(path))
    .sort();
  const removed = [...remoteMap.keys()].filter(path => !localMap.has(path)).sort();
  return { added, modified, removed, pending: added.length + modified.length + removed.length };
}

const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// 并发池（上限 concurrency），每完成一个任务小睡 30–100ms jitter——同时打出的
// 并发请求是 GitHub secondary rate limit 的典型触发姿势，掺点抖动礼貌一点。
async function mapLimit(items, concurrency, worker, sleepImpl) {
  const results = new Map();
  let index = 0;
  const size = Math.max(1, Math.min(concurrency, items.length));
  const runners = Array.from({ length: size }, async () => {
    while (index < items.length) {
      const current = items[index];
      index += 1;
      const value = await worker(current);
      results.set(current.path, value);
      await sleepImpl(30 + Math.floor(Math.random() * 70));
    }
  });
  await Promise.all(runners);
  return results;
}

// IO 组合：本地副本 → 远程一次提交。
// - confirm 回调收到 { diff, truncated }，返回 false 则中止（什么都不发）。
// - **truncated 仓库直接拒绝**：清单不完整时「完整树」会把看不见的远程文件全删，
//   宁可诚实失败（引导用户用逐文件 handoff 模式）。
// - ref 冲突（期间远程被推进）：提交的 parent 是旧 sha → updateRef 非快进被 GitHub
//   拒绝（409/422），我们绝不 force 重试。
export async function pushRepoSnapshot({
  store,
  characterId,
  owner,
  repo,
  branch,
  token,
  message,
  fetchImpl = fetch,
  sleepImpl = defaultSleep,
  concurrency = 5,
  confirm,
} = {}) {
  const prefix = `repos/${owner}/${repo}/${branch}/`;
  const files = await store.listWorkspaceFiles({ characterId });
  const localPaths = (Array.isArray(files) ? files : [])
    .filter(entry => String(entry).startsWith(prefix) && !String(entry).endsWith('/'));
  // 读全部本地文件并算 blob sha（本地副本只有文本，6MB 级内存可接受）。
  const localFiles = [];
  for (const filePath of localPaths) {
    const result = await store.readWorkspaceFile({ characterId, path: filePath });
    const text = String((result && result.content) || '');
    localFiles.push({
      path: String(filePath).slice(prefix.length),
      content: text,
      sha: computeGitBlobSha(text),
    });
  }
  const remote = await listTree({ fetchImpl, token, owner, repo, ref: branch });
  if (remote.truncated === true) return { ok: false, reason: 'truncated' };
  const diff = diffRemoteLocal({ localFiles, remoteEntries: remote.entries });
  if (diff.pending === 0) return { empty: true, diff };
  if (typeof confirm === 'function') {
    const proceed = await confirm({ diff });
    if (!proceed) return { cancelled: true, diff };
  }
  // 父提交（ref 指向的 commit）：期间远程被推进 → updateRef 非快进被拒（安全失败）。
  const parentSha = await getRef({ fetchImpl, token, owner, repo, branch });
  // 新树条目：未改沿用远程 sha；新增/修改创建 blob；删除给 sha:null。
  const byPath = new Map(localFiles.map(item => [item.path, item]));
  const needBlob = [...diff.added, ...diff.modified].map(path => byPath.get(path)).filter(Boolean);
  const blobShas = await mapLimit(
    needBlob,
    concurrency,
    item => createBlob({
      fetchImpl,
      token,
      owner,
      repo,
      content: bytesToBase64(strToU8(item.content)),
    }),
    sleepImpl
  );
  const entries = [];
  for (const item of remote.entries) {
    if (item.type !== 'blob') continue;
    if (diff.removed.includes(item.path)) continue; // 删除的不列出（保持原样）
    if (blobShas.has(item.path)) continue; // 修改的用新 blob
    entries.push({ path: item.path, mode: '100644', type: 'blob', sha: item.sha });
  }
  for (const item of needBlob) {
    entries.push({ path: item.path, mode: '100644', type: 'blob', sha: blobShas.get(item.path) });
  }
  for (const path of diff.removed) {
    entries.push({ path, mode: '100644', type: 'blob', sha: null });
  }
  const treeSha = await createTree({ fetchImpl, token, owner, repo, tree: entries });
  const commitMessage = String(message || '').trim() || `更新 ${diff.pending} 个文件（easychat2）`;
  const commitSha = await createCommit({
    fetchImpl,
    token,
    owner,
    repo,
    message: commitMessage,
    tree: treeSha,
    parents: parentSha ? [parentSha] : [],
  });
  await updateRef({ fetchImpl, token, owner, repo, branch, sha: commitSha });
  return { ok: true, diff, commit: commitSha };
}
