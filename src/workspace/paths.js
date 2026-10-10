// 工作区路径安全（纯函数，零依赖，可 Node 直测）。
//
// 契约：所有路径都是工作区沙盒内的**相对路径**；越界、绝对路径、空路径、
// 二进制/媒体扩展名一律抛错，避免 agent 触达沙盒外的文件，也避免把二进制当文本读写。
//
// 从「只支持 txt/md」放宽到「可写项目」：文本读写采用**黑名单**（媒体/压缩包/可执行/
// 字体/数据库/办公二进制之外的扩展名都当文本），这样 HTML/CSS/JS/JSON/YAML/各语言源码、
// 无扩展名文件（Makefile/.gitignore/LICENSE）都能建；.docx 仍是「只写不读」的二进制输出。

import { tActive } from '../i18n/index.js';

const BINARY_EXTENSIONS = new Set([
  // 图片
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'tif', 'tiff', 'heic', 'heif', 'avif', 'svgz',
  // 音频
  'mp3', 'wav', 'ogg', 'oga', 'flac', 'm4a', 'aac', 'opus', 'wma', 'amr', 'mid', 'midi',
  // 视频
  'mp4', 'm4v', 'mov', 'avi', 'mkv', 'webm', '3gp', 'wmv', 'flv',
  // 压缩包 / 安装包 / 库
  'zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'jar', 'aar', 'apk', 'ipa', 'deb', 'rpm',
  // 可执行 / 目标文件
  'exe', 'dll', 'so', 'dylib', 'bin', 'class', 'o', 'obj', 'a', 'lib', 'wasm', 'pyc', 'pyo',
  // 字体
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  // 数据库 / 办公 / 文档二进制
  'db', 'sqlite', 'sqlite3', 'realm', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp',
]);

// 只写不读的二进制输出（生成的 Word 等）。
const OUTPUT_ONLY_EXTENSIONS = new Set(['docx']);
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
  if (!raw.trim()) throw new Error(tActive('error.workspace.pathEmpty'));
  if (raw.includes('\u0000')) throw new Error(tActive('error.workspace.pathIllegalChar'));
  if (raw.length > MAX_PATH_LENGTH) throw new Error(tActive('error.workspace.pathTooLong'));
  const unified = raw.replace(/\\/g, '/').trim();
  if (unified.startsWith('/')) throw new Error(tActive('error.workspace.pathMustBeRelative'));
  const segments = [];
  for (const segment of unified.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') throw new Error(tActive('error.workspace.pathEscape'));
    segments.push(segment);
  }
  if (segments.length === 0) throw new Error(tActive('error.workspace.pathEmpty'));
  return segments.join('/');
}

export function fileExtension(path) {
  const name = String(path || '').split('/').pop() || '';
  const index = name.lastIndexOf('.');
  return index <= 0 ? '' : name.slice(index + 1).toLowerCase();
}

// 可作为**文本**读写的文件：扩展名不在二进制黑名单里（含无扩展名的 Makefile/LICENSE 等）。
export function isTextWorkspaceFile(path) {
  return !BINARY_EXTENSIONS.has(fileExtension(path));
}

// 兼容旧名：读取/写入文本文件的判定。
export function isAllowedWorkspaceFile(path) {
  return isTextWorkspaceFile(path);
}

export function assertAllowedWorkspaceFile(path) {
  if (!isAllowedWorkspaceFile(path)) {
    throw new Error(tActive('error.workspace.textOnly'));
  }
  return path;
}

// 可写入的文件：文本文件 + 生成的 .docx（二进制）。
export function isAllowedWorkspaceOutputFile(path) {
  return isTextWorkspaceFile(path) || OUTPUT_ONLY_EXTENSIONS.has(fileExtension(path));
}

export function assertAllowedWorkspaceOutputFile(path) {
  if (!isAllowedWorkspaceOutputFile(path)) {
    throw new Error(tActive('error.workspace.writeTextOnly'));
  }
  return path;
}

// 可列出（供 agent/UI 感知）的文件：文本文件与 .docx；读取仍限文本。
export function isListableWorkspaceFile(path) {
  return isAllowedWorkspaceOutputFile(path);
}

// ---- 受保护的写入路径（2026-10-10）----
//
// 审计与快照类文件：**agent 不得改写**（只能由内部模块自己写）。
// 覆盖它们等于抹掉审计线索与后悔药：
//   · .easychat/sessions/     —— E4 会话事件流（审计线索，只写不回读）
//   · .easychat/file-history/ —— J1 写前快照（「恢复错了再恢复一次」的依据）
//   · .easychat/rollback/     —— H3 推送前基线（回滚远端改动的唯一依据）
//
// 为什么在**路径层**而不是权限规则层：写工具（write_workspace_file /
// edit_workspace_file）不需要逐条确认，因此根本不走权限规则求值——放权限层等于没拦。
// 为什么在**工具边界**而不是 store 层：fileHistory / sessionEvents / rollbackBaseline
// 这些内部写入者直接调 store，必须继续能写。守卫只加在写工具的 execute 入口。
//
// 边界（如实说明，不假装完整）：run_shell 仍能改这些文件——那是需要用户逐条确认的
// 通道，用户看得见命令原文。与 Claude Code「Bash 改的文件不进检查点」属同类平台边界。
const PROTECTED_WRITE_PREFIXES = Object.freeze([
  '.easychat/sessions/',
  '.easychat/file-history/',
  '.easychat/rollback/',
]);

// 归一化成与 store 同口径的相对路径（去 ./、折叠多余 /），再判前缀。
export function isProtectedWorkspacePath(path) {
  const clean = String(path == null ? '' : path)
    .replace(/\\/g, '/')
    .split('/')
    .filter(segment => segment && segment !== '.')
    .join('/');
  if (!clean) return false;
  return PROTECTED_WRITE_PREFIXES.some(prefix => clean === prefix.slice(0, -1) || clean.startsWith(prefix));
}

export function assertWritableWorkspacePath(path) {
  if (isProtectedWorkspacePath(path)) {
    throw new Error(tActive('error.workspace.pathProtected'));
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
