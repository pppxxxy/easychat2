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
  const files = [];
  for (const entry of declared) {
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
  return { files, skippedSlip, skippedOversize, totalBytes, entryCount: declared.length };
}// 解压并筛出可落盘的**文本**文件（工作区不收二进制；图片等跳过并计数）。
// 返回 { files: [{ path, content }], skippedBinary, skippedSlip }。
export function extractRepoFiles(bytes, rootPrefix, limits = REPO_IMPORT_LIMITS) {
  const scan = scanRepoZipball(bytes, rootPrefix, limits);
  const wanted = new Set(scan.files.map(item => item.path));
  const extracted = unzipSync(bytes, {
    filter: file => {
      const relative = stripZipballEntry(file.name, rootPrefix);
      return !!relative && wanted.has(relative);
    },
  });
  const files = [];
  let skippedBinary = 0;
  for (const [entryName, data] of Object.entries(extracted)) {
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
  return { files, skippedBinary, skippedSlip: scan.skippedSlip, skippedOversize: scan.skippedOversize };
}
