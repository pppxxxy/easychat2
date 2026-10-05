// 工作区文件命名（纯函数，零依赖，可 Node 直测）。
//
// 用户/agent 给出的文件名先净化（去掉路径分隔符，杜绝 `../` 越界），
// 再按用途补扩展名：已带合法文本扩展名则保留，否则补 .txt；Word 走 .docx。
// 最终仍由 paths.js 的二进制黑名单兜底校验，这里只负责「让名字变成合法候选」。

import { fileExtension, isAllowedWorkspaceFile } from './paths.js';

export function isDocxName(name) {
  return /\.docx$/i.test(String(name || ''));
}

export function sanitizeWorkspaceFileName(name, fallback = '未命名') {
  const clean = String(name || '')
    .replace(/[\\/]+/g, '-')
    .trim()
    .replace(/\.+$/, '');
  return clean || fallback;
}

// 文本/项目文件命名：已带合法文本扩展名（.js/.md/.json…）原样保留；
// 没有扩展名时按「新建文本」的默认补 .txt；二进制扩展名（.png 等）一律补 .txt 使其可用。
export function ensureTextFileName(name) {
  const clean = sanitizeWorkspaceFileName(name, '未命名');
  return isAllowedWorkspaceFile(clean) && fileExtension(clean) ? clean : `${clean}.txt`;
}

// 文件夹命名：保留 `/` 以支持多级目录（如 src/components）；合法性（越界等）
// 由 paths.normalizeWorkspacePath 在 store 层兜底校验，这里只给空值兜底。
export function ensureDirectoryName(name) {
  return String(name === undefined || name === null ? '' : name).trim() || '新建文件夹';
}

export function ensureDocxFileName(name) {
  const clean = sanitizeWorkspaceFileName(name, '文档');
  return isDocxName(clean) ? clean : `${clean}.docx`;
}