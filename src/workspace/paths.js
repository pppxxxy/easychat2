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

// ---- 段级越界判据（**唯一一份**，2026-10-11 P0）----
//
// 为什么不能只拦字面量 `..`：路径最终会拼成 URI 交给原生层，而 Android 的
// `Uri.getPath()` 会**百分号解码**（expo-file-system 的 FileSystemLegacyModule.kt 里
// `File(this.path!!)`）。于是 `a/%2e%2e/%2e%2e/x` 在 JS 侧是一个普通段、原样通过，
// 到了原生侧解码成 `a/../../x` —— 直接逃出 `workspace/<id>/`。双重编码
//（`%252e%252e`）在解码一次后仍是 `%2e%2e`，同样要拦。
//
// 判据取「拒绝任何含 `%` 的段」而不是「先解码再判 `..`」：解码只能解一次，
// 而 URI 到原生可能解码多轮；含 `%` 的段在合法工作区路径里没有用途（文件名里的
// `%` 会被原生侧当转义序列解释，本来就不是可靠的可寻址名字）。宁可拒绝，不可漏放。
//
// 本函数是**共享判据**：主沙盒（normalizeWorkspacePath）与 git 文件系统
//（gitFs.js 的 normalizeGitPath）都调它。此前 gitFs 自己拦了 `..`/`%2e%2e`/`..%2f`，
// 主沙盒漏了 —— 同一威胁模型两处实现，修一处漏一处。现在只有一处。
export function assertSafeWorkspaceSegment(segment) {
  const value = String(segment === undefined || segment === null ? '' : segment);
  if (!value) return '';
  if (value === '..' || value.includes('%')) {
    throw new Error(tActive('error.workspace.pathEscape'));
  }
  return value;
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
    segments.push(assertSafeWorkspaceSegment(segment));
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
//
// **大小写不敏感**（2026-10-11 P1）：SAF 后端按**显示名**查找子项
//（safStore.js 的 findChild 用 `entry.name === name`），而 Android 的 SAF 显示名
// 大小写由实际文件系统决定；`isProtectedWorkspacePath` 若按大小写敏感判前缀，
// `.easychat/SESSIONS/x.jsonl` 这类变体就会绕过守卫（写入后与真实目录同名不同串）。
// 判据侧一律折成小写：宁可多拦一个变体，不可漏放一个。
export function isProtectedWorkspacePath(path) {
  const clean = String(path == null ? '' : path)
    .replace(/\\/g, '/')
    .split('/')
    .filter(segment => segment && segment !== '.')
    .join('/')
    .toLowerCase();
  if (!clean) return false;
  return PROTECTED_WRITE_PREFIXES.some(prefix => clean === prefix.slice(0, -1) || clean.startsWith(prefix));
}

export function assertWritableWorkspacePath(path) {
  if (isProtectedWorkspacePath(path)) {
    throw new Error(tActive('error.workspace.pathProtected'));
  }
  return path;
}

// ---- 列表隐形前缀（2026-10-11 P1）----
//
// 内部审计/快照/中间产物目录：**不进任何列表枚举**。这不是「保密」而是「口径」——
// 列表是模型用来理解工作区结构的视图，把内部账本混进去会让它把审计流当成项目内容
//（读一堆 JSONL 事件、回滚基线当源码分析），也让文件面板噪声化。
//
//  · .easychat/sessions/     —— E4 会话事件流（审计线索）
//  · .easychat/file-history/ —— J1 写前快照（恢复依据）
//  · .easychat/rollback/     —— H3 推送前基线（回滚依据）
//  · .easychat/board/        —— 跨会话黑板（模型走 board_read 读，不看原始 JSON）
//  · .task_outputs/          —— O1 超限工具结果落盘（模型拿指针按 offset 精读）
//
// **仍然可按路径读取**：`.task_outputs` 的指针契约就是「用 read_workspace_file 按
// offset 取回」，隐藏的是枚举，不是读取。要连读取一起禁是另一件事（会破坏 O1）。
//
// 为什么放这里（而不是各后端各写一份）：store.js 与 safStore.js 此前各有一份隐形清单，
// 且**已经不一致**（safStore 漏了 board）。判据集中一处，两个后端共用。
export const HIDDEN_LIST_PREFIXES = Object.freeze([
  '.easychat/sessions/',
  '.easychat/file-history/',
  '.easychat/rollback/',
  '.easychat/board/',
  '.task_outputs/',
]);

// 列表条目是否属于内部目录（纯函数：两个后端共用同一口径）。
export function isHiddenListEntry(entry) {
  const clean = String(entry === undefined || entry === null ? '' : entry).replace(/\\/g, '/');
  return HIDDEN_LIST_PREFIXES.some(prefix => clean.startsWith(prefix));
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
