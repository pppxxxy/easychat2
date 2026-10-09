// 外部根（Android SAF）文件读写后端。
//
// 为什么不能用 store.js 那套：legacy 的 readDirectoryAsync 对 content:// 直接抛
// UnsupportedSchemeException，而「列目录」正是 list_workspace_files 的地基。
// 所以外部根走 expo-file-system v19 的新 API（Directory/File 类），它内部是
// SAFDocumentFile → DocumentFile，list/create/读写都支持，且授权在
// takePersistableUriPermission 之后重启仍有效。
//
// 关键约束：content:// 不是路径，**不能靠字符串拼接**。每一次下降都是一次
// 「列出父目录 → 按显示名找同名子项 → 没有就 createDirectory」的查找，
// 所以这里所有解析都是按段进行的，并且读写路径与 list 路径分开：
// 只有写路径允许 createDirectory，读路径不得产生任何副作用。
//
// adapter 注入（Node 可直测）：listChildren / createDirectory / createFile /
// readText / writeText / writeBase64 / delete。

import {
  assertAllowedWorkspaceFile,
  assertAllowedWorkspaceOutputFile,
  isListableWorkspaceFile,
  normalizeWorkspacePath,
  sanitizeSandboxId,
} from './paths.js';
import { applyWorkspaceEdit } from './edit.js';
import { tActive } from '../i18n/index.js';

const MAX_FILES = 2000;
const MAX_DEPTH = 6;
const MAX_READ_CHARS = 1024 * 1024;
// 编辑专用上限，与 legacy 后端 store.js 同值（见那边的说明）。
const MAX_EDIT_CHARS = 4 * 1024 * 1024;

const TEXT_MIME = 'text/plain';
// .docx 的官方 MIME：SAF 的 createFile 用它给新建文档定类型，写内容仍是我们自己的字节。
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function assertAdapter(adapter) {
  if (!adapter || typeof adapter.listChildren !== 'function') {
    throw new Error(tActive('error.workspace.adapterMissing'));
  }
  if (typeof adapter.createDirectory !== 'function' || typeof adapter.createFile !== 'function') {
    throw new Error(tActive('error.workspace.adapterNoCreate'));
  }
  if (typeof adapter.readText !== 'function' || typeof adapter.writeText !== 'function') {
    throw new Error(tActive('error.workspace.adapterNoReadWrite'));
  }
}

async function listChildren(adapter, uri) {
  try {
    const entries = await adapter.listChildren(uri);
    return Array.isArray(entries) ? entries.filter(Boolean) : [];
  } catch (error) {
    // 目录不存在 / 授权失效都当作空目录：调用方据此给出「不存在」而不是崩掉整个面板。
    return [];
  }
}

async function findChild(adapter, parentUri, name, wantDirectory) {
  const children = await listChildren(adapter, parentUri);
  return children.find(entry => (
    entry.name === name
    && (wantDirectory === undefined || entry.isDirectory === wantDirectory)
  )) || null;
}

async function ensureChildDirectory(adapter, parentUri, name) {
  const found = await findChild(adapter, parentUri, name, true);
  if (found) return found.uri;
  return adapter.createDirectory(parentUri, name);
}

// 逐段下降到目标目录。create=true 时缺哪级建哪级（写路径）；
// create=false 时缺一级就返回 null（读路径，不得凭空建目录）。
async function resolveDirectory(adapter, rootUri, segments, create) {
  let current = rootUri;
  for (const segment of segments) {
    if (create) {
      current = await ensureChildDirectory(adapter, current, segment);
      continue;
    }
    const found = await findChild(adapter, current, segment, true);
    if (!found) return null;
    current = found.uri;
  }
  return current;
}

async function walk(adapter, directoryUri, prefix, results, depth) {
  if (results.length >= MAX_FILES || depth > MAX_DEPTH) return;
  const children = await listChildren(adapter, directoryUri);
  for (const child of children) {
    if (results.length >= MAX_FILES) return;
    const relative = prefix ? `${prefix}/${child.name}` : child.name;
    if (child.isDirectory) {
      results.push(`${relative}/`);
      await walk(adapter, child.uri, relative, results, depth + 1);
    } else if (isListableWorkspaceFile(relative)) {
      results.push(relative);
    }
  }
}

function splitRelative(relative) {
  const segments = relative.split('/');
  return { directories: segments.slice(0, -1), name: segments[segments.length - 1] };
}

function assertRoot(rootUri) {
  const value = String(rootUri || '');
  if (!value) throw new Error(tActive('error.workspace.rootMissing'));
}

export function createSafWorkspaceStore({ root, adapter } = {}) {
  const rootUri = String(root || '');
  // 装配期就校验：配置错了要立刻抛（面板能当场提示），而不是等用户点了列表才报错。
  assertAdapter(adapter);
  assertRoot(rootUri);

  async function locateDirectory(characterId, directories, create) {
    return resolveDirectory(adapter, rootUri, [sanitizeSandboxId(characterId), ...directories], create);
  }

  async function locateFile({ characterId, path, create }) {
    const relative = normalizeWorkspacePath(path);
    const { directories, name } = splitRelative(relative);
    const directoryUri = await locateDirectory(characterId, directories, create);
    if (!directoryUri) return { relative, directoryUri: null, file: null };
    const file = await findChild(adapter, directoryUri, name, false);
    return { relative, directoryUri, file };
  }

  return {
    rootKind: 'saf',

    async listWorkspaceFiles({ characterId, subdir = '' } = {}) {
      const relBase = String(subdir || '').trim() ? normalizeWorkspacePath(subdir) : '';
      const start = await locateDirectory(characterId, relBase ? relBase.split('/') : [], false);
      if (!start) return [];
      const results = [];
      await walk(adapter, start, relBase, results, 0);
      return results.sort();
    },

    async readWorkspaceFile({ characterId, path, maxChars = MAX_READ_CHARS, offset = 0 } = {}) {
      const relative = normalizeWorkspacePath(path);
      assertAllowedWorkspaceFile(relative);
      const { name, directories } = splitRelative(relative);
      const directoryUri = await locateDirectory(characterId, directories, false);
      if (!directoryUri) throw new Error(tActive('error.workspace.fileNotFound', { path: relative }));
      const found = await findChild(adapter, directoryUri, name, false);
      if (!found) throw new Error(tActive('error.workspace.fileNotFound', { path: relative }));
      const text = String(await adapter.readText(found.uri));
      // 分段读取与 legacy 后端同口径（见 store.js）：offset/maxChars + total/nextOffset。
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
    },

    async writeWorkspaceFile({ characterId, path, content } = {}) {
      const relative = normalizeWorkspacePath(path);
      assertAllowedWorkspaceFile(relative);
      const { name, directories } = splitRelative(relative);
      const directoryUri = await locateDirectory(characterId, directories, true);
      let target = await findChild(adapter, directoryUri, name, false);
      if (!target) {
        const createdUri = await adapter.createFile(directoryUri, name, TEXT_MIME);
        target = { uri: createdUri, name };
      }
      const text = typeof content === 'string'
        ? content
        : String(content === undefined || content === null ? '' : content);
      await adapter.writeText(target.uri, text);
      return { path: relative, length: text.length };
    },

    async writeWorkspaceBinaryFile({ characterId, path, base64 } = {}) {
      const relative = normalizeWorkspacePath(path);
      assertAllowedWorkspaceOutputFile(relative);
      const { name, directories } = splitRelative(relative);
      const directoryUri = await locateDirectory(characterId, directories, true);
      let target = await findChild(adapter, directoryUri, name, false);
      if (!target) {
        const mime = relative.toLowerCase().endsWith('.docx') ? DOCX_MIME : 'application/octet-stream';
        const createdUri = await adapter.createFile(directoryUri, name, mime);
        target = { uri: createdUri, name };
      }
      const payload = String(base64 === undefined || base64 === null ? '' : base64);
      if (typeof adapter.writeBase64 === 'function') await adapter.writeBase64(target.uri, payload);
      else await adapter.writeText(target.uri, payload);
      return { path: relative, base64Length: payload.length };
    },

    // 精确替换：与 legacy 后端同一规则（edit.js），只是读写都走 SAF。
    // 截断守卫同 store.js：用编辑专用上限完整读取，超限明确拒绝——绝不带截断内容回写。
    async editWorkspaceFile({ characterId, path, find, replace, all = false } = {}) {
      const current = await this.readWorkspaceFile({ characterId, path, maxChars: MAX_EDIT_CHARS });
      if (current.truncated) {
        throw new Error(
          `文件过大（超过 ${Math.floor(MAX_EDIT_CHARS / 1024 / 1024)}MB），无法精确替换以免损坏内容；请改用整体重写。`
        );
      }
      const edited = applyWorkspaceEdit({ content: current.content, find, replace, all });
      const written = await this.writeWorkspaceFile({ characterId, path, content: edited.content });
      return { path: written.path, count: edited.count, length: written.length };
    },

    // 新建目录（缺哪级建哪级）。SAF 没有「目录是否已存在」的廉价判定，
    // resolveDirectory(create=true) 已是幂等（存在则复用），故 created 仅表示「已确保存在」。
    async createWorkspaceDirectory({ characterId, path } = {}) {
      const relative = normalizeWorkspacePath(path);
      const directoryUri = await locateDirectory(characterId, relative.split('/'), true);
      return { path: `${relative}/`, created: Boolean(directoryUri) };
    },

    // 面板分享/删除要拿到具体文件 uri；找不到返回 null（文件已被用户在文件管理器里删掉）。
    async fileUri({ characterId, path } = {}) {
      const { file } = await locateFile({ characterId, path, create: false });
      return file ? file.uri : null;
    },

    async deleteFile({ characterId, path } = {}) {
      const relative = normalizeWorkspacePath(path);
      const { file } = await locateFile({ characterId, path: relative, create: false });
      if (!file) return { path: relative, deleted: false };
      if (typeof adapter.delete !== 'function') throw new Error(tActive('error.workspace.adapterNoDelete'));
      await adapter.delete(file.uri);
      return { path: relative, deleted: true };
    },

    // 空目录删除（F2）：只删**直接子项为空**的目录——非空拒绝（防误删整棵导入树）。
    // SAF 的 Directory.delete 是递归语义，一旦调用不可逆，所以「空」的校验必须在
    // 删除之前；UI 层同样门控（双重保险，不靠调用方自觉）。
    async deleteWorkspaceDirectory({ characterId, path } = {}) {
      // 空/非法路径（'', '/', null…）= 沙盒根，不允许删（防手滑清空整个工作区）。
      // normalize 对空路径会抛错，这里先安全接住——删除入口宁可静默不删也不能炸。
      let relative = '';
      try {
        relative = normalizeWorkspacePath(path);
      } catch (error) {
        return { path: '', deleted: false };
      }
      const segments = relative.split('/').filter(Boolean);
      if (segments.length === 0) return { path: relative, deleted: false };
      const dirUri = await locateDirectory(characterId, segments, false);
      if (!dirUri) return { path: relative, deleted: false };
      const children = await adapter.listChildren(dirUri);
      if (children.length > 0) throw new Error(tActive('error.workspace.dirNotEmpty'));
      if (typeof adapter.deleteDirectory !== 'function') throw new Error(tActive('error.workspace.adapterNoDelete'));
      await adapter.deleteDirectory(dirUri);
      return { path: relative, deleted: true };
    },

    // 目录改名/移动（重命名 GitHub 仓库时同步本地副本）。SAF 后端要求 adapter 提供 moveDirectory
    // （expo v19 的 Directory.move）；源不存在返回 moved:false，目标已存在拒绝覆盖。
    async moveWorkspaceDirectory({ characterId, from, to } = {}) {
      const source = normalizeWorkspacePath(from);
      const target = normalizeWorkspacePath(to);
      if (source === target) return { from: source, to: target, moved: false };
      const sourceUri = await locateDirectory(characterId, source.split('/'), false);
      if (!sourceUri) return { from: source, to: target, moved: false };
      const targetUri = await locateDirectory(characterId, target.split('/'), false);
      if (targetUri) throw new Error(tActive('error.workspace.moveTargetExists', { path: target }));
      if (typeof adapter.moveDirectory !== 'function') {
        throw new Error(tActive('error.workspace.moveUnsupported'));
      }
      const targetParent = target.split('/').slice(0, -1);
      const parentUri = await locateDirectory(characterId, targetParent, true);
      const targetName = target.split('/').slice(-1)[0];
      await adapter.moveDirectory(sourceUri, parentUri, targetName);
      return { from: source, to: target, moved: true };
    },
  };
}

// expo-file-system v19 新 API 适配器。惰性由调用方传入模块（测试环境 require 原生模块会抛）。
export function createExpoSafAdapter(fileSystemModule) {
  const Directory = fileSystemModule && fileSystemModule.Directory;
  const File = fileSystemModule && fileSystemModule.File;
  if (typeof Directory !== 'function' || typeof File !== 'function') {
    throw new Error(tActive('error.workspace.newFileSystemApiMissing'));
  }
  return {
    async listChildren(dirUri) {
      return new Directory(dirUri).list().map(entry => ({
        uri: entry.uri,
        name: entry.name,
        isDirectory: entry instanceof Directory,
      }));
    },
    async createDirectory(parentUri, name) {
      return new Directory(parentUri).createDirectory(name).uri;
    },
    async createFile(parentUri, name, mimeType) {
      return new Directory(parentUri).createFile(name, mimeType || TEXT_MIME).uri;
    },
    async readText(uri) {
      return new File(uri).text();
    },
    async writeText(uri, text) {
      new File(uri).write(text);
    },
    async writeBase64(uri, base64) {
      new File(uri).write(base64, { encoding: 'base64' });
    },
    async delete(uri) {
      new File(uri).delete();
    },
    // expo v19：Directory.delete() 递归删目录——**调用方（store）负责保证目录为空**
    //（F2 的空目录校验在 store 层，这里只是能力暴露）。
    async deleteDirectory(uri) {
      new Directory(uri).delete();
    },
    // expo v19：Directory.move(destination) 把目录改名/搬到目标路径（目标不应已存在）。
    async moveDirectory(uri, parentUri, name) {
      const base = String(parentUri || '').endsWith('/') ? parentUri : `${parentUri}/`;
      const destination = `${base}${name}`;
      new Directory(uri).move(destination);
      return destination;
    },
  };
}

export const SAF_LIMITS = Object.freeze({ MAX_FILES, MAX_DEPTH, MAX_READ_CHARS, MAX_EDIT_CHARS });
