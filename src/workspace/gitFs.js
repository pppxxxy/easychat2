// 工作区 git 的文件系统适配器（W7）。
//
// 为什么需要它：isomorphic-git 要的是 **Node fs 形状**的接口——POSIX 相对路径、带
// isFile()/isDirectory() 的 Stat 对象、Buffer 读写。我们手上只有 expo-file-system 的
// **URI + 异步字符串**接口（`readAsStringAsync` / `writeAsStringAsync` /
// `readDirectoryAsync` / `makeDirectoryAsync` / `deleteAsync` / `getInfoAsync`）。
// 这层只做两件事：路径 ↔ URI 映射、契约翻译。
//
// **不复用工具层的路径守卫**：工具层按扩展名只放行文本文件（`isTextWorkspaceFile`），
// 而 `.git/` 里全是没有扩展名的对象与引用（HEAD、config、objects/ab/cdef…），走工具层
// 守卫等于 git 根本起不来。这里自带最小守卫：拒绝绝对路径与 `..` 段（越界防护不降级），
// 其余放行。
//
// **已知不支持（如实声明，不假装）**：symlink / readlink。我们自己的仓库不会有 120000
// 条目；真遇到就明确报错，而不是静默写坏仓库。chmod 静默忽略（Android 上没有权限位
// 概念，且 isomorphic-git 只在 core.filemode 相关处才调）。
//
// 用法约定：isomorphic-git 一律以 `dir: '/'` 调用（仓库根 = 沙盒根），路径映射由本层
// 独占，调用方不要再拼沙盒前缀。

import { Buffer } from 'buffer';
import { sandboxDirectory } from './paths.js';
import { tActive } from '../i18n/index.js';

// git 路径 → 规范化相对路径。拒绝绝对路径与任何 `..` 段（含 URL 编码形态）。
export function normalizeGitPath(path) {
  const raw = String(path === undefined || path === null ? '' : path).replace(/\\/g, '/');
  const withoutRoot = raw.replace(/^\/+/, '').replace(/^\.\//, '');
  if (!withoutRoot) return '';
  const segments = withoutRoot.split('/');
  for (const segment of segments) {
    if (segment === '..' || segment === '%2e%2e' || segment === '..%2f') {
      throw new Error(tActive('error.workspace.gitPathEscape', { path: String(path) }));
    }
  }
  return segments.filter(segment => segment !== '' && segment !== '.').join('/');
}

function enoent(path) {
  const error = new Error(`ENOENT: no such file or directory, '${path}'`);
  error.code = 'ENOENT';
  return error;
}

// Node fs.Stats 的最小可用形状：isomorphic-git 用 isDirectory()/isFile()/isSymbolicLink()
// 判类型，用 mode 判对象类型（040000=tree / 100644=blob）。
function makeStats({ isDirectory, size = 0, mtimeMs = 0 }) {
  const seconds = Math.floor(mtimeMs / 1000);
  return {
    ctimeSeconds: seconds,
    ctimeNanoseconds: 0,
    mtimeSeconds: seconds,
    mtimeNanoseconds: 0,
    dev: 1,
    ino: 1,
    mode: isDirectory ? 0o040755 : 0o100644,
    uid: 1,
    gid: 1,
    size,
    isFile: () => !isDirectory,
    isDirectory: () => !!isDirectory,
    isSymbolicLink: () => false,
  };
}

export function createGitFs({ root, characterId, fileSystem } = {}) {
  if (!fileSystem || typeof fileSystem.readAsStringAsync !== 'function') {
    throw new Error(tActive('error.workspace.fileSystemMissing'));
  }
  const sandbox = sandboxDirectory(root, characterId);
  const toUri = path => `${sandbox}${normalizeGitPath(path)}`;
  const infoOf = async uri => {
    try {
      return await fileSystem.getInfoAsync(uri);
    } catch (error) {
      return { exists: false };
    }
  };
  const unsupported = name => {
    throw new Error(tActive('error.workspace.gitUnsupported', { name }));
  };
  // 写文件前兜住父目录：Node 的 fs.writeFile 不建父目录（git 会自己 mkdir），但
  // expo-file-system 对不存在的父目录直接失败，而我们 store 的写路径本来就靠
  // ensureDirectory 兜（store.js 同款）。这里补上，git 的对象写入才不会随机失败。
  const ensureParent = async uri => {
    const parent = uri.replace(/\/[^/]*$/, '');
    if (!parent || parent === uri) return;
    await fileSystem.makeDirectoryAsync(parent, { intermediates: true });
  };

  return {
    async readFile(path, options) {
      const uri = toUri(path);
      if (options && options.encoding) return String(await fileSystem.readAsStringAsync(uri));
      // 无 encoding = 二进制（git 对象是 zlib 压缩字节）→ 走 base64 再还原字节。
      const base64 = await fileSystem.readAsStringAsync(uri, { encoding: 'base64' });
      return Buffer.from(String(base64 || ''), 'base64');
    },
    async writeFile(path, data, options) {
      const uri = toUri(path);
      await ensureParent(uri);
      if (typeof data === 'string') {
        await fileSystem.writeAsStringAsync(uri, data, options && options.encoding ? { encoding: options.encoding } : undefined);
        return;
      }
      const base64 = Buffer.from(data).toString('base64');
      await fileSystem.writeAsStringAsync(uri, base64, { encoding: 'base64' });
    },
    async unlink(path) {
      await fileSystem.deleteAsync(toUri(path), { idempotent: true });
    },
    // isomorphic-git 内部用 rm 递归删目录（Node 14+ 语义）。
    async rm(path) {
      await fileSystem.deleteAsync(toUri(path), { idempotent: true });
    },
    async readdir(path) {
      const entries = await fileSystem.readDirectoryAsync(toUri(path));
      return (Array.isArray(entries) ? entries : []).map(String);
    },
    // intermediates: true —— isomorphic-git 期望 mkdir 能建出父目录（Node recursive 语义）。
    async mkdir(path) {
      await fileSystem.makeDirectoryAsync(toUri(path), { intermediates: true });
    },
    async rmdir(path) {
      await fileSystem.deleteAsync(toUri(path), { idempotent: true });
    },
    async stat(path) {
      const info = await infoOf(toUri(path));
      if (!info || !info.exists) throw enoent(path);
      return makeStats({
        isDirectory: !!info.isDirectory,
        size: Number(info.size) || 0,
        mtimeMs: Number(info.modificationTime) ? Number(info.modificationTime) * 1000 : 0,
      });
    },
    async lstat(path) {
      // 无符号链接 → lstat 与 stat 同义。
      return this.stat(path);
    },
    async exists(path) {
      const info = await infoOf(toUri(path));
      return !!(info && info.exists);
    },
    // 静默忽略：Android 上没有权限位，且 git 只在 core.filemode 相关路径调它。
    async chmod() {},
    readlink: () => unsupported('readlink'),
    symlink: () => unsupported('symlink'),
  };
}
