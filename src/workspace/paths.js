// 工作区路径安全（纯函数，零依赖，可 Node 直测）。
//
// 契约：所有路径都是工作区沙盒内的**相对路径**；越界、绝对路径、空路径、
// 二进制/媒体扩展名一律抛错，避免 agent 触达沙盒外的文件，也避免把二进制当文本读写。
//
// 从「只支持 txt/md」放宽到「可写项目」：文本读写采用**黑名单**（媒体/压缩包/可执行/
// 字体/数据库/办公二进制之外的扩展名都当文本），这样 HTML/CSS/JS/JSON/YAML/各语言源码、
// 无扩展名文件（Makefile/.gitignore/LICENSE）都能建；.docx 仍是「只写不读」的二进制输出。

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
    throw new Error('工作区只能读写文本文件（图片/音视频/压缩包/可执行文件等二进制不支持）。');
  }
  return path;
}

// 可写入的文件：文本文件 + 生成的 .docx（二进制）。
export function isAllowedWorkspaceOutputFile(path) {
  return isTextWorkspaceFile(path) || OUTPUT_ONLY_EXTENSIONS.has(fileExtension(path));
}

export function assertAllowedWorkspaceOutputFile(path) {
  if (!isAllowedWorkspaceOutputFile(path)) {
    throw new Error('工作区写入只支持文本文件与生成的 .docx。');
  }
  return path;
}

// 可列出（供 agent/UI 感知）的文件：文本文件与 .docx；读取仍限文本。
export function isListableWorkspaceFile(path) {
  return isAllowedWorkspaceOutputFile(path);
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
