// 工作区文件命名（纯函数，零依赖，可 Node 直测）。
//
// 用户/agent 给出的文件名先净化（去掉路径分隔符，杜绝 `../` 越界），
// 再按用途补扩展名：文本走 .txt，Word 走 .docx。最终仍由 paths.js 的
// 白名单兜底校验，这里只负责「让名字变成合法候选」。

import { isAllowedWorkspaceFile } from './paths.js';

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

export function ensureTextFileName(name) {
  const clean = sanitizeWorkspaceFileName(name, '未命名');
  return isAllowedWorkspaceFile(clean) ? clean : `${clean}.txt`;
}

export function ensureDocxFileName(name) {
  const clean = sanitizeWorkspaceFileName(name, '文档');
  return isDocxName(clean) ? clean : `${clean}.docx`;
}