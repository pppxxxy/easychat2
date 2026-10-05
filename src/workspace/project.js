// GitHub 仓库拉取与项目目录（纯逻辑 + XHR 下载，零原生依赖）。
//
// 为什么走 zipball 而不是 git clone：设备上不保证有 git 二进制，而 zipball 只要
// 一个 HTTPS 请求就能拿到某个分支的完整快照；解压用内置的 fflate（纯 JS）。
// 拉下来之后的增量改动仍走 MCP 工具（create_or_update_file / push_files），
// 或在「可改」模式 + 命令执行开启时用 shell 里的 git（设备装了 git 才行）。
//
// 落盘位置：沙盒内 projects/<owner>__<repo>/ 之下——不占用沙盒根，方便与其他
// 手工建的文件区分，也避免不同 owner 下的同名仓库互相覆盖。

import { strFromU8, unzipSync } from 'fflate';

import { isListableWorkspaceFile } from './paths.js';

export const PROJECTS_DIR = 'projects';

// 单次导入的护栏：仓库可能很大，一次全塞进沙盒既慢又可能撑爆存储。
const MAX_FILES = 400;
const MAX_FILE_BYTES = 512 * 1024;
const DOWNLOAD_TIMEOUT_MS = 90000;

// 解析仓库输入：owner/repo、github.com/owner/repo、https://github.com/owner/repo(.git)、
// git@github.com:owner/repo.git 都认。解析不出返回 null（由界面提示格式）。
export function parseRepoInput(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  let text = raw;
  text = text.replace(/^git@github\.com:/i, '');
  text = text.replace(/^https?:\/\/(www\.)?github\.com\//i, '');
  text = text.replace(/^github\.com\//i, '');
  text = text.replace(/\.git$/i, '');
  text = text.replace(/^\/+/, '').replace(/\/+$/, '');
  const parts = text.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0];
  const repo = parts[1];
  // GitHub 的 owner/repo 只允许字母数字、-、_、.；再挡掉纯点段（`..` 会进目录名，属路径噪声）。
  if (!/^[A-Za-z0-9._-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo)) return null;
  if (/^\.+$/.test(owner) || /^\.+$/.test(repo)) return null;
  return { owner, repo };
}

// 项目目录名（沙盒内的相对目录）：owner__repo。
export function projectDirectoryName(owner, repo) {
  return `${String(owner || '').trim()}__${String(repo || '').trim()}`;
}

export function buildRepoZipUrl(owner, repo, branch = '') {
  const clean = String(branch || '').trim();
  const suffix = clean ? `/${encodeURIComponent(clean)}` : '';
  return `https://api.github.com/repos/${owner}/${repo}/zipball${suffix}`;
}

export function buildRepoHeaders(token = '') {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const value = String(token || '').trim();
  if (value) headers.Authorization = `Bearer ${value}`;
  return headers;
}

// 带错误码的失败：界面按 code 取 i18n 文案（本模块是纯逻辑，不引 i18n）。
function repoError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// 二进制下载（XHR + arraybuffer：RN 原生支持，不必依赖 fetch 的 blob polyfill）。
export function downloadBinary(url, headers = {}, { timeoutMs = DOWNLOAD_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url);
    xhr.responseType = 'arraybuffer';
    Object.keys(headers).forEach(key => {
      try {
        xhr.setRequestHeader(key, headers[key]);
      } catch (error) {}
    });
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(new Uint8Array(xhr.response));
        return;
      }
      if (xhr.status === 401 || xhr.status === 403) {
        reject(repoError('REPO_AUTH', 'GitHub refused the request (bad token or no access)'));
        return;
      }
      if (xhr.status === 404) {
        reject(repoError('REPO_NOT_FOUND', 'Repository or branch not found'));
        return;
      }
      reject(repoError('REPO_HTTP', `Download failed: HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(repoError('REPO_NETWORK', 'Network request failed'));
    xhr.ontimeout = () => reject(repoError('REPO_TIMEOUT', 'Download timed out'));
    xhr.timeout = timeoutMs;
    xhr.send();
  });
}

// 解压 zipball → 文本文件清单。
// zipball 的顶层目录是 `owner-repo-<sha>/`，剥掉这一层再落盘，否则项目里会多套一层。
export function extractRepoFiles(bytes, { maxFiles = MAX_FILES, maxFileBytes = MAX_FILE_BYTES } = {}) {
  const unzipped = unzipSync(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []));
  const names = Object.keys(unzipped).filter(name => !name.endsWith('/'));
  // zipball 的顶层恒为 `owner-repo-<sha>/`：只有当**所有**条目共享同一个首段目录时才剥掉它，
  // 避免仓库本身只有一个顶层目录时把用户自己的目录结构吃掉。
  const firstSegments = new Set(names.map(name => name.split('/')[0]));
  const rootPrefix = names.length && firstSegments.size === 1 && names.every(name => name.includes('/'))
    ? `${names[0].split('/')[0]}/`
    : '';
  const files = [];
  let skipped = 0;
  for (const name of names) {
    if (files.length >= maxFiles) {
      skipped += 1;
      continue;
    }
    const relative = rootPrefix && name.startsWith(rootPrefix) ? name.slice(rootPrefix.length) : name;
    if (!relative) continue;
    // 二进制/媒体/压缩包等由 paths.js 统一黑名单判定：这里只导入能当文本读写的文件，
    // 其余（图片、字体、jar…）跳过——沙盒的文本写入通道写不了它们。
    if (!isListableWorkspaceFile(relative)) {
      skipped += 1;
      continue;
    }
    const data = unzipped[name];
    if (!data || data.length > maxFileBytes) {
      skipped += 1;
      continue;
    }
    let content = '';
    try {
      content = strFromU8(data);
    } catch (error) {
      skipped += 1;
      continue;
    }
    files.push({ path: relative, content });
  }
  return { files, skipped, total: names.length };
}

// 把解压出来的文本文件逐个写进沙盒的项目目录。
// 单个文件失败（路径过长/扩展名不允许）只跳过、不中断整次导入。
export async function importProjectToWorkspace({
  store,
  characterId,
  projectName,
  files,
  onProgress,
} = {}) {
  if (!store || typeof store.writeWorkspaceFile !== 'function') {
    throw new Error('Workspace is not writable: missing file system backend.');
  }
  const list = Array.isArray(files) ? files : [];
  const prefix = `${PROJECTS_DIR}/${String(projectName || '').trim()}`;
  let written = 0;
  let failed = 0;
  for (let index = 0; index < list.length; index += 1) {
    const item = list[index];
    try {
      await store.writeWorkspaceFile({
        characterId,
        path: `${prefix}/${item.path}`,
        content: item.content,
      });
      written += 1;
    } catch (error) {
      failed += 1;
    }
    if (typeof onProgress === 'function' && (index % 10 === 0 || index === list.length - 1)) {
      onProgress(index + 1, list.length);
    }
  }
  return { written, failed, total: list.length };
}
