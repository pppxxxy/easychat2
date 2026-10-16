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
  MAX_DEPTH,
  MAX_EDIT_CHARS,
  MAX_FILES,
  MAX_READ_CHARS,
  WORKSPACE_LIMITS,
  assertAllowedWorkspaceFile,
  assertAllowedWorkspaceOutputFile,
  isHiddenListEntry,
  isListableWorkspaceFile,
  normalizeWorkspacePath,
  sanitizeSandboxId,
} from './paths.js';
import { applyWorkspaceEdit } from './edit.js';
import { tActive } from '../i18n/index.js';

// 护栏常量只有一份，在 paths.js（此前这里 MAX_DEPTH=6、store.js=12，两个后端漂移：
// SAF 下深度 ≥7 的目录内容既不列出也不告警）。SAF_LIMITS 这个名字保留给既有测试/调用方，
// 它指的**就是同一个冻结对象**——"同值"由结构保证，不靠两边各写一遍 12 维持。
export const SAF_LIMITS = WORKSPACE_LIMITS;

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

async function walk(adapter, directoryUri, prefix, results, depth, fileFilter, state, depthLimit) {
  if (results.length >= MAX_FILES) {
    state.truncated = true;
    return;
  }
  // 与 legacy 后端同款：深度到顶也是截断，**必须**置标记 —— 两线各自独立修了同一缺陷
  //（2026-10-10 / 2026-10-12）。原先这里静默 return；叠加 SAF 根与 legacy 的 MAX_DEPTH
  // 漂移，SAF 下 7 层以上的目录内容**既不列出也不告警**，清单被当成完整事实
  //（G1.7 要防的正是这个）。现两侧常量已统一到 paths.js 的 WORKSPACE_LIMITS。
  if (depth > MAX_DEPTH) {
    state.truncated = true;
    return;
  }
  // AC12 P0-1：单层列举模式（文件面板下钻用，与 legacy 后端同款语义）。
  const singleLevel = depthLimit === 1;
  const children = await listChildren(adapter, directoryUri);
  for (const child of children) {
    if (results.length >= MAX_FILES) {
      state.truncated = true;
      return;
    }
    const relative = prefix ? `${prefix}/${child.name}` : child.name;
    if (child.isDirectory) {
      // match 模式下只列匹配的文件（目录不进结果，但仍继续下钻）。
      if (!fileFilter) results.push(`${relative}/`);
      if (!singleLevel) {
        await walk(adapter, child.uri, relative, results, depth + 1, fileFilter, state, depthLimit);
      }
    } else if (isListableWorkspaceFile(relative) && (!fileFilter || fileFilter(relative))) {
      results.push(relative);
    }
  }
}

function baseName(relative) {
  const segments = String(relative || '').split('/');
  return segments[segments.length - 1] || '';
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

  // —— R5：目录 URI 缓存（**只服务写路径**）——
  // 病根（实测）：content:// 不是路径，逐段下降 = 每段一次 content-resolver IPC。
  // 拉取 1066 个文件时，每个文件的父路径（repos/o/r/main/src/... ≈ 9-10 段）都要
  // 从根重新下降一遍，约 1.2 万次串行 IPC——而 1066 个文件其实只共享约 250 个目录，
  // 八成定位是重复劳动。缓存后每个文件只剩「查文件 + 写」两次 IPC。
  //
  // 为什么**不给读路径**用：listChildren 对失败是「当空目录」（见上），死链缓存会让
  // 列表/读取静默变空——那比慢严重得多。写路径的失败是显式抛错，可以自愈（见下）。
  const dirCache = new Map();
  const dirKey = (characterId, directories) => [sanitizeSandboxId(characterId), ...directories].join('\u0000');

  async function locateDirectoryCached(characterId, directories) {
    const key = dirKey(characterId, directories);
    const hit = dirCache.get(key);
    if (hit) return hit;
    const uri = await resolveDirectory(adapter, rootUri, [sanitizeSandboxId(characterId), ...directories], true);
    if (uri) dirCache.set(key, uri);
    return uri;
  }

  // 缓存失效（含子孙：父目录 uri 一旦作废，子孙 uri 也跟着作废）。
  function invalidateDirectory(characterId, directories) {
    const key = dirKey(characterId, directories);
    dirCache.delete(key);
    const prefix = `${key}\u0000`;
    for (const cached of [...dirCache.keys()]) {
      if (cached.startsWith(prefix)) dirCache.delete(cached);
    }
  }

  // 写路径统一入口：缓存命中即用；一旦失败就假定「用户在文件管理器里删/改过目录」，
  // 失效重建后**重试一次**（写入本身幂等：同路径同内容），仍失败才把错误交给上层。
  async function withDirectoryCache(characterId, directories, run) {
    try {
      return await run(() => locateDirectoryCached(characterId, directories));
    } catch (error) {
      invalidateDirectory(characterId, directories);
      return run(() => locateDirectoryCached(characterId, directories));
    }
  }

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

    async listWorkspaceFiles({ characterId, subdir = '', match = '', depth } = {}) {
      const { files } = await this.listWorkspaceFilesWithMeta({ characterId, subdir, match, depth });
      return files;
    },

    // 带截断标记的列表（与 legacy 后端同口径）：list_workspace_files 工具据此附告警行。
    async listWorkspaceFilesWithMeta({ characterId, subdir = '', match = '', depth } = {}) {
      const relBase = String(subdir || '').trim() ? normalizeWorkspacePath(subdir) : '';
      const start = await locateDirectory(characterId, relBase ? relBase.split('/') : [], false);
      if (!start) return { files: [], truncated: false };
      const needle = String(match || '').trim().toLowerCase();
      const fileFilter = needle
        ? relative => baseName(relative).toLowerCase().includes(needle)
        : null;
      const depthLimit = depth === undefined ? undefined : Math.max(1, Math.floor(Number(depth) || 1));
      const results = [];
      const state = { truncated: false };
      await walk(adapter, start, relBase, results, 0, fileFilter, state, depthLimit);
      // 内部目录隐形（与 store.js 同一份判据，见 paths.js 的 HIDDEN_LIST_PREFIXES）——
      // 此前这里只藏了 file-history，漏了 board / sessions / rollback / .task_outputs。
      const files = results.filter(entry => !isHiddenListEntry(entry)).sort();
      return { files, truncated: state.truncated };
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
      const text = typeof content === 'string'
        ? content
        : String(content === undefined || content === null ? '' : content);
      // R5：目录定位走缓存（命中即免 9-10 次 IPC）；失败时失效重建再试一次。
      return withDirectoryCache(characterId, directories, async locate => {
        const directoryUri = await locate();
        let target = await findChild(adapter, directoryUri, name, false);
        if (!target) {
          const createdUri = await adapter.createFile(directoryUri, name, TEXT_MIME);
          target = { uri: createdUri, name };
        }
        await adapter.writeText(target.uri, text);
        return { path: relative, length: text.length };
      });
    },

    async writeWorkspaceBinaryFile({ characterId, path, base64 } = {}) {
      const relative = normalizeWorkspacePath(path);
      assertAllowedWorkspaceOutputFile(relative);
      const { name, directories } = splitRelative(relative);
      const payload = String(base64 === undefined || base64 === null ? '' : base64);
      return withDirectoryCache(characterId, directories, async locate => {
        const directoryUri = await locate();
        let target = await findChild(adapter, directoryUri, name, false);
        if (!target) {
          const mime = relative.toLowerCase().endsWith('.docx') ? DOCX_MIME : 'application/octet-stream';
          const createdUri = await adapter.createFile(directoryUri, name, mime);
          target = { uri: createdUri, name };
        }
        if (typeof adapter.writeBase64 === 'function') await adapter.writeBase64(target.uri, payload);
        else await adapter.writeText(target.uri, payload);
        return { path: relative, base64Length: payload.length };
      });
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
      // R5：目录本身也进缓存（批量建目录时省掉整条下降链）。
      const directoryUri = await withDirectoryCache(
        characterId,
        relative.split('/'),
        async locate => locate()
      );
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
      // **故意不 try/catch**（别"统一"成 store.js 里那种吞异常再当空目录的写法）：
      // adapter.listChildren 抛错时异常直接外传 ⇒ 下面那行 deleteDirectory 根本不会执行，
      // 也就不会用递归语义删掉一棵非空目录树。这里的"不安全写法"反而是安全的那一侧，
      // 而 legacy 后端（store.js:265-272）已改成读失败即 return { deleted:false } 的同款结论。
      const children = await adapter.listChildren(dirUri);
      if (children.length > 0) throw new Error(tActive('error.workspace.dirNotEmpty'));
      if (typeof adapter.deleteDirectory !== 'function') throw new Error(tActive('error.workspace.adapterNoDelete'));
      await adapter.deleteDirectory(dirUri);
      // R5：缓存里的这条（及其子孙）已作废——不清就会指向一个不存在的目录。
      invalidateDirectory(characterId, segments);
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
      // R5：源路径作废、目标路径重新下降（旧 uri 两边都不再可信）。
      invalidateDirectory(characterId, source.split('/'));
      invalidateDirectory(characterId, target.split('/'));
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
