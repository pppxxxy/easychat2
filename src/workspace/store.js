// 工作区文件读写。fileSystem 由调用方注入（原生用 expo-file-system/legacy，
// 测试用内存实现），故本模块零原生依赖、可 Node 直测。

import {
  assertAllowedWorkspaceFile,
  assertAllowedWorkspaceOutputFile,
  isListableWorkspaceFile,
  normalizeWorkspacePath,
  sandboxDirectory,
} from './paths.js';
import { applyWorkspaceEdit } from './edit.js';
import { FILE_HISTORY_DIR } from './fileHistory.js';
import { BOARD_DIR } from './boardStore.js';
import { tActive } from '../i18n/index.js';

const MAX_FILES = 2000;
// 6 会把导入仓库里 src/i18n/locales/zh-CN/x.js 这类真实路径直接藏掉（实测：注入 4 个
// 深路径文件只列出 2 个）。提到 12 覆盖正常项目结构；MAX_FILES=2000 仍是主护栏。
const MAX_DEPTH = 12;
const MAX_READ_CHARS = 1024 * 1024;
// 编辑专用上限：读路径 1MB 截断是为上下文经济；编辑要的是完整性，给到 4MB，
// 超过则拒绝（见 editWorkspaceFile 的截断守卫）。
const MAX_EDIT_CHARS = 4 * 1024 * 1024;

function assertFileSystem(fileSystem) {
  if (!fileSystem || typeof fileSystem.readAsStringAsync !== 'function') {
    throw new Error(tActive('error.workspace.fileSystemMissing'));
  }
}

async function getInfo(fileSystem, uri) {
  try {
    return await fileSystem.getInfoAsync(uri);
  } catch (error) {
    return { exists: false };
  }
}

async function ensureDirectory(fileSystem, uri) {
  const info = await getInfo(fileSystem, uri);
  if (info && info.exists) {
    // 父路径被一个同名文件占着：再往下写只会拿到 Android 裸抛的 ENOTDIR（错误信息里
    // 没有「谁占了路」）。这里快速失败并说清原因，排查成本从「猜」降到「一眼」。
    if (info.isDirectory === false) {
      throw new Error(tActive('error.workspace.parentIsFile', { path: uri }));
    }
    return;
  }
  await fileSystem.makeDirectoryAsync(uri, { intermediates: true });
}

async function walk(fileSystem, directoryUri, prefix, results, depth, fileFilter, state) {
  if (results.length >= MAX_FILES) {
    state.truncated = true;
    return;
  }
  if (depth > MAX_DEPTH) return;
  let entries = [];
  try {
    entries = await fileSystem.readDirectoryAsync(directoryUri);
  } catch (error) {
    return;
  }
  for (const entry of entries) {
    if (results.length >= MAX_FILES) {
      state.truncated = true;
      return;
    }
    const relative = prefix ? `${prefix}/${entry}` : entry;
    const uri = `${directoryUri}${entry}`;
    const info = await getInfo(fileSystem, uri);
    if (info && info.isDirectory) {
      // match 模式下只列匹配的文件（目录不进结果，但仍继续下钻）——即「按名找文件」。
      if (!fileFilter) results.push(`${relative}/`);
      await walk(fileSystem, `${uri}/`, relative, results, depth + 1, fileFilter, state);
    } else if (isListableWorkspaceFile(relative) && (!fileFilter || fileFilter(relative))) {
      results.push(relative);
    }
  }
}

// 文件名（末段）。match 过滤按文件名子串，不看目录。
function baseName(relative) {
  const segments = String(relative || '').split('/');
  return segments[segments.length - 1] || '';
}

// 列表实现（带截断标记）：match 过滤在遍历时生效（先过滤再套 MAX_FILES/MAX_DEPTH 上限），
// 使匹配文件不会被海量无关文件挤出上限。返回 { files, truncated }。
export async function listWorkspaceFilesDetailed({ root, characterId, fileSystem, subdir = '', match = '' } = {}) {
  assertFileSystem(fileSystem);
  const base = sandboxDirectory(root, characterId);
  const relBase = String(subdir || '').trim() ? normalizeWorkspacePath(subdir) : '';
  const start = relBase ? `${base}${relBase}/` : base;
  const needle = String(match || '').trim().toLowerCase();
  const fileFilter = needle
    ? relative => baseName(relative).toLowerCase().includes(needle)
    : null;
  const results = [];
  const state = { truncated: false };
  await walk(fileSystem, start, relBase, results, 0, fileFilter, state);
  // J1：file-history 是隐形历史——不进列表枚举（恢复走专用入口），也不刷文件面板。
  // 注意 listWorkspaceFiles 的调用方（agent 的 list 工具 / 文件面板 / 压缩扫描）都
  // 不应该看到这批内部文件；fileHistory 模块自己用直读（readIndex），不依赖列表。
  // 跨会话黑板（.easychat/board/）同款隐形：模型走 board_read 读，不看原始 JSON。
  const hiddenPrefixes = [`${FILE_HISTORY_DIR}/`, `${BOARD_DIR}/`];
  const files = results.filter(entry => !hiddenPrefixes.some(prefix => String(entry).startsWith(prefix))).sort();
  return { files, truncated: state.truncated };
}

export async function listWorkspaceFiles({ root, characterId, fileSystem, subdir = '', match = '' } = {}) {
  const { files } = await listWorkspaceFilesDetailed({ root, characterId, fileSystem, subdir, match });
  return files;
}

export async function readWorkspaceFile({ root, characterId, path, fileSystem, maxChars = MAX_READ_CHARS, offset = 0 } = {}) {
  assertFileSystem(fileSystem);
  const relative = normalizeWorkspacePath(path);
  assertAllowedWorkspaceFile(relative);
  const uri = `${sandboxDirectory(root, characterId)}${relative}`;
  const info = await getInfo(fileSystem, uri);
  if (!info || !info.exists) throw new Error(tActive('error.workspace.fileNotFound', { path: relative }));
  if (info.isDirectory) throw new Error(tActive('error.workspace.targetIsDirectory', { path: relative }));
  const text = String(await fileSystem.readAsStringAsync(uri));
  // 分段读取：offset 从指定字符位置开始、最多 maxChars；返回总长与下一段偏移，
  // 模型据此续读——大文件不必一次塞进上下文（编码助手同款口径）。
  const requested = Number(offset);
  const safeStart = Math.min(Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 0, text.length);
  const content = text.slice(safeStart, safeStart + maxChars);
  const end = safeStart + content.length;
  const truncated = end < text.length;
  return {
    path: relative,
    content,
    truncated,
    offset: safeStart,
    total: text.length,
    ...(truncated ? { nextOffset: end } : {}),
  };
}

export async function writeWorkspaceFile({ root, characterId, path, content, fileSystem } = {}) {
  assertFileSystem(fileSystem);
  const relative = normalizeWorkspacePath(path);
  assertAllowedWorkspaceFile(relative);
  const sandbox = sandboxDirectory(root, characterId);
  const uri = `${sandbox}${relative}`;
  const parent = uri.slice(0, uri.lastIndexOf('/') + 1);
  await ensureDirectory(fileSystem, sandbox);
  await ensureDirectory(fileSystem, parent);
  const text = typeof content === 'string'
    ? content
    : String(content === undefined || content === null ? '' : content);
  await fileSystem.writeAsStringAsync(uri, text);
  return { path: relative, length: text.length };
}

// 二进制写入（如导出的 .docx）：内容以 base64 传入，落盘用 base64 编码。
export async function writeWorkspaceBinaryFile({ root, characterId, path, base64, fileSystem } = {}) {
  assertFileSystem(fileSystem);
  const relative = normalizeWorkspacePath(path);
  assertAllowedWorkspaceOutputFile(relative);
  const sandbox = sandboxDirectory(root, characterId);
  const uri = `${sandbox}${relative}`;
  const parent = uri.slice(0, uri.lastIndexOf('/') + 1);
  await ensureDirectory(fileSystem, sandbox);
  await ensureDirectory(fileSystem, parent);
  const payload = String(base64 === undefined || base64 === null ? '' : base64);
  await fileSystem.writeAsStringAsync(uri, payload, { encoding: 'base64' });
  return { path: relative, base64Length: payload.length };
}

// 目录改名/移动（重命名 GitHub 仓库时同步本地副本目录）。
// from/to 都是沙盒内相对路径；目标已存在则拒绝（不覆盖既有目录）；源不存在返回 moved:false。
export async function moveWorkspaceDirectory({ root, characterId, from, to, fileSystem } = {}) {
  assertFileSystem(fileSystem);
  const source = normalizeWorkspacePath(from);
  const target = normalizeWorkspacePath(to);
  if (source === target) return { from: source, to: target, moved: false };
  const sandbox = sandboxDirectory(root, characterId);
  const sourceUri = `${sandbox}${source}`;
  const sourceInfo = await getInfo(fileSystem, sourceUri);
  if (!sourceInfo || !sourceInfo.exists) return { from: source, to: target, moved: false };
  if (sourceInfo.isDirectory === false) {
    throw new Error(tActive('error.workspace.moveSourceNotDirectory', { path: source }));
  }
  const targetUri = `${sandbox}${target}`;
  const targetInfo = await getInfo(fileSystem, targetUri);
  if (targetInfo && targetInfo.exists) {
    throw new Error(tActive('error.workspace.moveTargetExists', { path: target }));
  }
  const targetSegments = target.split('/');
  const targetParent = targetSegments.slice(0, -1).join('/');
  await ensureDirectory(fileSystem, targetParent ? `${sandbox}${targetParent}/` : sandbox);
  if (typeof fileSystem.moveAsync !== 'function') {
    throw new Error(tActive('error.workspace.moveUnsupported'));
  }
  await fileSystem.moveAsync({ from: sourceUri, to: targetUri });
  return { from: source, to: target, moved: true };
}

export const WORKSPACE_LIMITS = Object.freeze({ MAX_FILES, MAX_DEPTH, MAX_READ_CHARS, MAX_EDIT_CHARS });

// 列表截断提示（G1.7，纯函数）：命中护栏时如实告知，让模型知道「没看到 ≠ 不存在」。
//
// 为什么必须有：列表静默截断是「推送误删」那类事故的放大器——模型（和用户）看到
// 一份不完整的清单，却当成完整的事实来推理。两处护栏分别可判定：
//  · 文件数到顶（walk 写满即停，length 可等于 MAX_FILES）；
//  · 有目录正好处在深度上限（它本身会被列出，但内容不会再展开）。
export function listTruncationNotice(files) {
  const list = Array.isArray(files) ? files : [];
  const atFileCap = list.length >= MAX_FILES;
  const deepDirs = list.filter(entry => {
    const text = String(entry || '');
    return text.endsWith('/') && text.split('/').filter(Boolean).length >= MAX_DEPTH;
  });
  if (!atFileCap && deepDirs.length === 0) return '';
  const reasons = [];
  if (atFileCap) reasons.push(`文件数达到上限 ${MAX_FILES} 条`);
  if (deepDirs.length > 0) reasons.push(`${deepDirs.length} 个目录已达 ${MAX_DEPTH} 层深度上限，其内容未展开`);
  return `（注意：本列表可能不完整——${reasons.join('；')}。用 subdir 指定子目录可看到其余部分）`;
}

// 新建目录（含中间层级）。已存在且是目录时 created=false，不报错。
export async function createWorkspaceDirectory({ root, characterId, path, fileSystem } = {}) {
  assertFileSystem(fileSystem);
  const relative = normalizeWorkspacePath(path);
  const uri = `${sandboxDirectory(root, characterId)}${relative}`;
  const info = await getInfo(fileSystem, uri);
  if (info && info.exists && info.isDirectory) return { path: `${relative}/`, created: false };
  await ensureDirectory(fileSystem, `${uri}/`);
  return { path: `${relative}/`, created: true };
}

// 精确文本替换：读 → 替换 → 写回。匹配规则见 edit.js（默认要求唯一匹配）。
export async function editWorkspaceFile({ root, characterId, path, find, replace, all = false, fileSystem } = {}) {
  // 编辑必须拿到**完整**内容：读路径默认在 1MB 截断，带着截断内容替换再写回
  // 会把文件尾部静默砍掉（数据损坏）。这里用更高的编辑专用上限完整读取；
  // 仍超限就明确拒绝，并提示改用整体重写（write_workspace_file 无此上限）。
  const current = await readWorkspaceFile({ root, characterId, path, fileSystem, maxChars: MAX_EDIT_CHARS });
  if (current.truncated) {
    throw new Error(
      `文件过大（超过 ${Math.floor(MAX_EDIT_CHARS / 1024 / 1024)}MB），无法精确替换以免损坏内容；请改用整体重写。`
    );
  }
  const edited = applyWorkspaceEdit({ content: current.content, find, replace, all });
  const written = await writeWorkspaceFile({ root, characterId, path, content: edited.content, fileSystem });
  return { path: written.path, count: edited.count, length: written.length };
}

// 空目录删除（F2）：与 SAF 后端同款语义——只删**直接子项为空**的目录。
// 非空拒绝（删除不可逆，校验必须在 deleteAsync 之前）；根路径不可删。
export async function deleteWorkspaceDirectory({ root, characterId, path, fileSystem } = {}) {
  assertFileSystem(fileSystem);
  // 空/非法路径（'', '/', null…）= 沙盒根，不允许删（防手滑清空整个工作区）。
  // normalize 对空路径会抛错，这里先安全接住——删除入口宁可静默不删也不能炸。
  let relative = '';
  try {
    relative = normalizeWorkspacePath(path);
  } catch (error) {
    return { path: '', deleted: false };
  }
  if (!relative.split('/').filter(Boolean).length) return { path: relative, deleted: false };
  const uri = `${sandboxDirectory(root, characterId)}${relative}`;
  const info = await getInfo(fileSystem, uri);
  if (!info || !info.exists || info.isDirectory === false) return { path: relative, deleted: false };
  let children = [];
  try {
    children = await fileSystem.readDirectoryAsync(uri);
  } catch (error) {
    children = [];
  }
  if (children.length > 0) throw new Error(tActive('error.workspace.dirNotEmpty'));
  await fileSystem.deleteAsync(uri, { idempotent: true });
  return { path: relative, deleted: true };
}

// 应用私有根的后端。与 safStore.js 的 createSafWorkspaceStore 暴露**同一组方法名**：
// 上层（tools.js / WorkspacePanel.js）只认这套接口，根是应用私有目录还是
// 用户自选的外部文件夹，对它都是同一件事——换的只是后端。
export function createLegacyWorkspaceStore({ root, fileSystem } = {}) {
  return {
    rootKind: 'app',

    listWorkspaceFiles: ({ characterId, subdir = '', match = '' } = {}) => listWorkspaceFiles({
      root, characterId, fileSystem, subdir, match,
    }),

    // 带截断标记的列表：list_workspace_files 工具据此在结果末尾附「已达上限」告警行。
    listWorkspaceFilesWithMeta: ({ characterId, subdir = '', match = '' } = {}) => listWorkspaceFilesDetailed({
      root, characterId, fileSystem, subdir, match,
    }),

    readWorkspaceFile: ({ characterId, path, maxChars, offset } = {}) => readWorkspaceFile({
      root, characterId, path, fileSystem, maxChars, offset,
    }),

    writeWorkspaceFile: ({ characterId, path, content } = {}) => writeWorkspaceFile({
      root, characterId, path, content, fileSystem,
    }),

    writeWorkspaceBinaryFile: ({ characterId, path, base64 } = {}) => writeWorkspaceBinaryFile({
      root, characterId, path, base64, fileSystem,
    }),

    editWorkspaceFile: ({ characterId, path, find, replace, all } = {}) => editWorkspaceFile({
      root, characterId, path, find, replace, all, fileSystem,
    }),

    createWorkspaceDirectory: ({ characterId, path } = {}) => createWorkspaceDirectory({
      root, characterId, path, fileSystem,
    }),

    moveWorkspaceDirectory: ({ characterId, from, to } = {}) => moveWorkspaceDirectory({
      root, characterId, from, to, fileSystem,
    }),

    // 面板的分享/删除要拿到具体文件 uri。legacy 后端里 uri 就是拼出来的字符串。
    async fileUri({ characterId, path } = {}) {
      const relative = normalizeWorkspacePath(path);
      const uri = `${sandboxDirectory(root, characterId)}${relative}`;
      const info = await getInfo(fileSystem, uri);
      return info && info.exists ? uri : null;
    },

    async deleteFile({ characterId, path } = {}) {
      assertFileSystem(fileSystem);
      const relative = normalizeWorkspacePath(path);
      const uri = `${sandboxDirectory(root, characterId)}${relative}`;
      const info = await getInfo(fileSystem, uri);
      if (!info || !info.exists) return { path: relative, deleted: false };
      await fileSystem.deleteAsync(uri, { idempotent: true });
      return { path: relative, deleted: true };
    },

    deleteWorkspaceDirectory: ({ characterId, path } = {}) => deleteWorkspaceDirectory({
      root, characterId, path, fileSystem,
    }),
  };
}