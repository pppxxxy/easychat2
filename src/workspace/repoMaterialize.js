// C2 按需物化：清单里存在、本地没有的文件——点开 / 读它时单文件拉取（contents
// API）写进沙盒。模块拆纯函数（路径解析 / URL / 响应解码）与 IO 薄壳，Node 直测。
//
// 为什么复用 C4 的 request：超时与退避基建已经在那里（429/断流自动重试），
// 单文件拉取不必另造一套。
import { strFromU8 } from 'fflate';

import { request } from './github/restApi.js';
import { parseRepoFilePath } from './repoPaths.js';

// 路径规则在 repoPaths.js（零依赖）——这里 re-export 保持既有引用面不变。
export { parseRepoFilePath };

// contents API 单文件 URL（rel 逐段编码——目录名里的空格/中文也要能拉）。
export function buildContentsUrl({ owner, repo, ref, rel } = {}) {
  const encoded = String(rel || '').split('/').map(encodeURIComponent).join('/');
  return `https://api.github.com/repos/${encodeURIComponent(String(owner || ''))}/${encodeURIComponent(String(repo || ''))}/contents/${encoded}?ref=${encodeURIComponent(String(ref || ''))}`;
}

// 纯函数：base64 → 字节数组（手写，不赌 Hermes 有没有 atob；标准字母表 + padding）。
export function base64ToBytes(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const clean = String(input || '').replace(/[\s\r\n]/g, '').replace(/=+$/, '');
  const bytes = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    const value = alphabet.indexOf(char);
    if (value < 0) continue; // 非法字符静默跳过（GitHub 不会发，但别炸）
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

// 纯函数：contents 响应 → { ok: true, text } | { ok: false, reason }。
// GitHub 对 >1MB 的文件不内联 content（encoding='none'）——如实返回 none，
// 调用方给「太大，请完整拉取」的提示，绝不假装成功。
export function extractContentsText(data) {
  const source = data && typeof data === 'object' ? data : {};
  if (source.encoding === 'base64' && typeof source.content === 'string') {
    try {
      return { ok: true, text: strFromU8(base64ToBytes(source.content)) };
    } catch (error) {
      return { ok: false, reason: 'decode' };
    }
  }
  return { ok: false, reason: 'none' };
}

// IO 薄壳：拉单文件 → 写进沙盒。返回 { ok } / { ok:false, reason }；
// 网络错误按原样抛出（调用方决定文案）——失败时绝不写入任何内容。
export async function materializeRepoFile({
  store,
  characterId,
  path,
  token,
  fetchImpl = fetch,
  requestImpl = request,
} = {}) {
  const target = parseRepoFilePath(path);
  if (!target) return { ok: false, reason: 'notRepoPath' };
  if (!store || typeof store.writeWorkspaceFile !== 'function') return { ok: false, reason: 'noStore' };
  const url = buildContentsUrl({
    owner: target.owner,
    repo: target.repo,
    ref: target.branch,
    rel: target.rel,
  });
  const { data } = await requestImpl(fetchImpl, url, { token });
  const extracted = extractContentsText(data);
  if (!extracted.ok) return extracted;
  await store.writeWorkspaceFile({ characterId, path, content: extracted.text });
  return { ok: true, chars: extracted.text.length };
}
