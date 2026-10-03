// 工作区路径安全（纯函数，零依赖，可 Node 直测）。
//
// 契约：所有路径都是工作区沙盒内的**相对路径**；越界、绝对路径、空路径、
// 非文本扩展名一律抛错，避免 agent 触达沙盒外的文件。

const ALLOWED_EXTENSIONS = new Set(['txt', 'md', 'markdown']);
const MAX_PATH_LENGTH = 240;
const MAX_SANDBOX_ID_LENGTH = 64;

export function sanitizeSandboxId(characterId) {
  const clean = String(characterId || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, MAX_SANDBOX_ID_LENGTH);
  return clean || 'default';
}

export function normalizeWorkspacePath(input) {
  const raw = String(input === undefined || input === null ? '' : input);
  if (!raw.trim()) throw new Error('路径不能为空。');
  if (raw.includes('\u0000')) throw new Error('路径包含非法字符。');
  if (raw.length > MAX_PATH_LENGTH) throw new Error('路径过长。');
  const unified = raw.replace(/\\/g, '/').trim();
  if (unified.startsWith('/')) throw new Error('路径必须是工作区内的相对路径。');
  const segments = [];
  for (const segment of unified.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') throw new Error('路径不能越出工作区。');
    segments.push(segment);
  }
  if (segments.length === 0) throw new Error('路径不能为空。');
  return segments.join('/');
}

export function fileExtension(path) {
  const name = String(path || '').split('/').pop() || '';
  const index = name.lastIndexOf('.');
  return index <= 0 ? '' : name.slice(index + 1).toLowerCase();
}

export function isAllowedWorkspaceFile(path) {
  return ALLOWED_EXTENSIONS.has(fileExtension(path));
}

export function assertAllowedWorkspaceFile(path) {
  if (!isAllowedWorkspaceFile(path)) {
    throw new Error('工作区第一版只支持纯文本与 Markdown（.txt/.md/.markdown）。');
  }
  return path;
}

export function sandboxDirectory(root, characterId) {
  const base = String(root || '');
  const separator = base.endsWith('/') ? '' : '/';
  return `${base}${separator}${sanitizeSandboxId(characterId)}/`;
}

export function resolveWorkspaceUri(root, characterId, path) {
  const relative = assertAllowedWorkspaceFile(normalizeWorkspacePath(path));
  return `${sandboxDirectory(root, characterId)}${relative}`;
}

export const WORKSPACE_ALLOWED_EXTENSIONS = ALLOWED_EXTENSIONS;