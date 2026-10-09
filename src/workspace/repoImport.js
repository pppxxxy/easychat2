// GitHub 仓库快照导入（纯函数 + 注入 fetch，Node 直测；沿用 catalog「纯数据零依赖」风格）。
//
// 为什么不是 git clone：run_shell 走 /system/bin/sh，Android 没有 git 二进制，
// clone 这条路是死的。可行路线 = codeload zip 快照 + fflate 解压（fflate 已在
// 依赖里，books 解 docx 用它）。产物是**分支快照**：没有 .git 历史；提交回
// GitHub 由工作区 agent 走 MCP GitHub 工具完成（安全分级见 mcpTools/riskGate）。
//
// 防御思路照抄 books/extractText 的成熟做法：
//   1) 先用「只读目录元数据」的 unzipSync 扫描（filter 全假 → 不 inflate 任何条目），
//      校验条目数/声明总量/单文件声明大小；
//   2) 再解压实际需要的条目，按**实际解出长度**复核（声明值可以伪造）；
//   3) zip-slip：逐条目剥掉 zipball 顶层目录后，路径段里出现 '..'、空段、绝对路径
//      一律跳过并计数，绝不落到沙盒外。
//   4) 目录条目：zipball 会把目录也列成条目（名字以 '/' 结尾、originalSize=0，GitHub
//      codeload 实测如此）。必须显式跳过——否则 '.github/' 会被折成 '.github' 当 0 字节
//      文本写入，随后 '.github/workflows' 要建同名父目录时撞上这个文件 → ENOTDIR →
//      整包回滚。任何前部带子目录的仓库都会 100% 导入失败（真机必现）。

import { unzipSync, strFromU8 } from 'fflate';
import { isTextWorkspaceFile } from './paths.js';

export const REPO_IMPORT_LIMITS = Object.freeze({
  // 压缩包大小在下载前后各查一次（Content-Length 预检 + 实际字节数复核）。
  MAX_DOWNLOAD_BYTES: 50 * 1024 * 1024,
  MAX_ENTRIES: 5000,
  MAX_TOTAL_UNCOMPRESSED_BYTES: 200 * 1024 * 1024,
  // 任务书给的 50MB 是磁盘口径；沙盒的 agent 读取预览上限是 1MB（store MAX_READ_CHARS），
  // 超过它连工作区 AI 自己都读不了，落进来没有意义——文本单文件上限对齐 1MB，超限跳过。
  MAX_FILE_BYTES: 1024 * 1024,
});

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// zipball 的目录条目：名字以 '/' 结尾（GitHub codeload 实测如此，如 '.github/'、
// '.github/workflows/'）。它们不是文件，必须跳过；被当成文件写进沙盒会让同名的
// 后续文件建目录失败（ENOTDIR）。顶层目录 '{repo}-{branch}/' 也走这里。
function isZipDirectoryEntry(name) {
  return String(name || '').endsWith('/');
}

export function buildReposApiUrl({ page = 1 } = {}) {
  const safePage = Number.isInteger(page) && page > 0 ? page : 1;
  return `https://api.github.com/user/repos?sort=pushed&per_page=30&visibility=all&page=${safePage}`;
}

export function buildRepoApiUrl({ owner, repo }) {
  return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

export function buildBranchesApiUrl({ owner, repo }) {
  return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=100`;
}

export function buildRepoZipUrl({ owner, repo, branch }) {
  return `https://codeload.github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/zip/refs/heads/${encodeURIComponent(branch)}`;
}

// 「owner/repo」或 GitHub 仓库页 URL → { owner, repo }；不合法返回 null。
export function parseRepoFullName(input) {
  let value = String(input || '').trim();
  if (!value) return null;
  const urlMatch = value.match(/^https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/i);
  if (urlMatch) return { owner: urlMatch[1], repo: urlMatch[2].replace(/\.git$/i, '') };
  value = value.replace(/^@/, '');
  const pair = value.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!pair) return null;
  return { owner: pair[1], repo: pair[2].replace(/\.git$/i, '') };
}

// zipball 条目统一带顶层目录 `{repo}-{branch}/`；剥掉后返回沙盒内相对路径。
// 非法路径（越界/绝对路径/目录条目本身）返回 ''，由调用方跳过并计数。
export function stripZipballEntry(entryName, rootPrefix) {
  let name = String(entryName || '');
  const prefix = String(rootPrefix || '');
  if (prefix) {
    if (!name.startsWith(prefix)) return '';
    name = name.slice(prefix.length);
  } else {
    const slash = name.indexOf('/');
    name = slash === -1 ? '' : name.slice(slash + 1);
  }
  if (!name) return '';
  const segments = [];
  for (const segment of name.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') return '';
    segments.push(segment);
  }
  if (segments.length === 0) return '';
  return segments.join('/');
}

// 只读目录元数据扫描 + 全部校验。通过后返回文件清单（相对路径 + 声明大小），
// 供解压阶段精确过滤；任何限额/安全检查不过抛带 code 的错误。
export function scanRepoZipball(bytes, rootPrefix, limits = REPO_IMPORT_LIMITS) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    throw fail('REPO_EMPTY', '下载内容为空');
  }
  if (bytes.length > limits.MAX_DOWNLOAD_BYTES) {
    throw fail('REPO_LIMIT_DOWNLOAD', `压缩包超过 ${Math.floor(limits.MAX_DOWNLOAD_BYTES / 1024 / 1024)}MB 上限`);
  }
  const declared = [];
  unzipSync(bytes, {
    filter: file => {
      declared.push(file);
      return false;
    },
  });
  if (declared.length > limits.MAX_ENTRIES) {
    throw fail('REPO_LIMIT_ENTRIES', `压缩包条目数 ${declared.length} 超过上限 ${limits.MAX_ENTRIES}`);
  }
  let totalBytes = 0;
  let skippedSlip = 0;
  let skippedOversize = 0;
  let skippedDirs = 0;
  const files = [];
  for (const entry of declared) {
    if (isZipDirectoryEntry(entry.name)) {
      skippedDirs += 1; // 目录条目：不是文件，跳过（顶层目录也在此）
      continue;
    }
    const relative = stripZipballEntry(entry.name, rootPrefix);
    if (!relative) {
      if (String(entry.name || '').replace(/\/$/, '') !== String(rootPrefix || '').replace(/\/$/, '')) {
        skippedSlip += 1; // 顶层目录本身不算越界；其余剥不掉前缀的都是可疑条目
      }
      continue;
    }
    const size = Number(entry.originalSize) || 0;
    totalBytes += size;
    if (size > limits.MAX_FILE_BYTES) {
      // 单文件超限跳过而非中止：超大的多是数据/日志文件，放弃它们不影响开工
      skippedOversize += 1;
      continue;
    }
    files.push({ path: relative, size });
  }
  if (totalBytes > limits.MAX_TOTAL_UNCOMPRESSED_BYTES) {
    throw fail('REPO_LIMIT_TOTAL', `解压总量超过 ${Math.floor(limits.MAX_TOTAL_UNCOMPRESSED_BYTES / 1024 / 1024)}MB 上限`);
  }
  return { files, skippedSlip, skippedOversize, skippedDirs, totalBytes, entryCount: declared.length };
}// 解压并筛出可落盘的**文本**文件（工作区不收二进制；图片等跳过并计数）。
// 返回 { files: [{ path, content }], skippedBinary, skippedSlip, skippedOversize, skippedDirs }。
export function extractRepoFiles(bytes, rootPrefix, limits = REPO_IMPORT_LIMITS) {
  const scan = scanRepoZipball(bytes, rootPrefix, limits);
  const wanted = new Set(scan.files.map(item => item.path));
  const extracted = unzipSync(bytes, {
    filter: file => {
      if (isZipDirectoryEntry(file.name)) return false;
      const relative = stripZipballEntry(file.name, rootPrefix);
      return !!relative && wanted.has(relative);
    },
  });
  const files = [];
  let skippedBinary = 0;
  for (const [entryName, data] of Object.entries(extracted)) {
    if (isZipDirectoryEntry(entryName)) continue;
    const relative = stripZipballEntry(entryName, rootPrefix);
    if (!relative || !wanted.has(relative)) continue;
    if (data.length > limits.MAX_FILE_BYTES) {
      skippedBinary += 1; // 声明值伪造的兜底：实际解出超限同样跳过
      continue;
    }
    if (!isTextWorkspaceFile(relative)) {
      skippedBinary += 1;
      continue;
    }
    files.push({ path: relative, content: strFromU8(data) });
  }
  return {
    files,
    skippedBinary,
    skippedSlip: scan.skippedSlip,
    skippedOversize: scan.skippedOversize,
    skippedDirs: scan.skippedDirs,
  };
}

// —— 拉取残留清单（F4）——
// 上千个文件逐个 SAF 写入要几分钟，中途锁屏/切后台可能被系统杀掉。拉取开始时
// 写一份清单，**成功结束才删除**——它的存在本身就是「上次没跑完」的信号，
// 下次拉取同一分支时据此提示「覆盖继续」。
// **刻意不做断点续传**：逐文件存在性探测在 SAF 上同样慢，收益不抵复杂度；
// 重跑全量覆盖是幂等且可靠的（重跑成本 = 主要成本，省不掉大头就不加这个复杂度）。
export const PULL_MANIFEST_PATH = '.easychat/pull-manifest.json';

// 纯函数：清单文本 → { owner, repo, branch, files, at }；坏输入 → null（当作没有）。
export function parsePullManifest(text) {
  try {
    const source = typeof text === 'string' ? JSON.parse(text) : text;
    if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
    const owner = String(source.owner || '').trim();
    const repo = String(source.repo || '').trim();
    const branch = String(source.branch || '').trim();
    if (!owner || !repo || !branch) return null;
    // files 兼容两种写法：数字（现行）或数组（防御旧数据/手写）。
    const files = Array.isArray(source.files)
      ? source.files.length
      : Math.max(0, Math.floor(Number(source.files) || 0));
    return { owner, repo, branch, files, at: Number(source.at) || 0 };
  } catch (error) {
    return null;
  }
}

// IO 薄壳：读/写/清都绝不抛错——清单是旁路机制，不能挡住拉取主流程。
export async function readPullManifest(store, characterId) {
  if (!store || typeof store.readWorkspaceFile !== 'function') return null;
  try {
    const result = await store.readWorkspaceFile({ characterId, path: PULL_MANIFEST_PATH });
    return parsePullManifest(result && result.content);
  } catch (error) {
    return null;
  }
}

export async function writePullManifest(store, characterId, { owner, repo, branch, files } = {}) {
  if (!store || typeof store.writeWorkspaceFile !== 'function') return false;
  try {
    await store.writeWorkspaceFile({
      characterId,
      path: PULL_MANIFEST_PATH,
      content: JSON.stringify({ owner, repo, branch, files, at: Date.now() }),
    });
    return true;
  } catch (error) {
    return false;
  }
}

export async function clearPullManifest(store, characterId) {
  if (!store || typeof store.deleteFile !== 'function') return false;
  try {
    await store.deleteFile({ characterId, path: PULL_MANIFEST_PATH });
    return true;
  } catch (error) {
    return false;
  }
}

// —— C1 清单缓存（快速检出的落盘位置）——
// 与 F4 的 pull-manifest **同域但分文件**：F4 是「成功即删」的临时信号
//（存在 = 上次没跑完），本清单是长期缓存（不删）——语义不同，合并成一份
// 会让「拉取成功删清单」把快速检出的树也删掉。共享的是同一套 IO 薄壳模式。
// 文件名把三段都 encodeURIComponent（branch 可能含 `/`，直接拼会造出假目录）。
export function repoManifestPath({ owner, repo, branch } = {}) {
  const key = [owner, repo, branch].map(part => encodeURIComponent(String(part || ''))).join('__');
  return `.easychat/repos-manifest/${key}.json`;
}

// 纯函数：清单文本 → { entries, truncated, at }；坏输入 → null（当作没有清单）。
export function parseRepoManifest(text) {
  try {
    const source = typeof text === 'string' ? JSON.parse(text) : text;
    if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
    const entries = (Array.isArray(source.entries) ? source.entries : [])
      .map(item => ({
        path: String((item && item.path) || ''),
        type: String((item && item.type) || (String((item && item.path) || '').endsWith('/') ? 'tree' : 'blob')),
        sha: String((item && item.sha) || ''),
        size: Number(item && item.size) || 0,
      }))
      .filter(item => item.path);
    return { entries, truncated: source.truncated === true, at: Number(source.at) || 0 };
  } catch (error) {
    return null;
  }
}

export async function readRepoManifest(store, characterId, key) {
  if (!store || typeof store.readWorkspaceFile !== 'function') return null;
  try {
    const result = await store.readWorkspaceFile({ characterId, path: repoManifestPath(key) });
    return parseRepoManifest(result && result.content);
  } catch (error) {
    return null;
  }
}

export async function writeRepoManifest(store, characterId, key, { entries, truncated } = {}) {
  if (!store || typeof store.writeWorkspaceFile !== 'function') return false;
  try {
    await store.writeWorkspaceFile({
      characterId,
      path: repoManifestPath(key),
      content: JSON.stringify({
        entries: Array.isArray(entries) ? entries : [],
        truncated: truncated === true,
        at: Date.now(),
      }),
    });
    return true;
  } catch (error) {
    return false;
  }
}
