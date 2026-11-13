// 桌面端路径边界：所有 IPC 入参的 uri/path 都在这里归一化并校验。
//
// 设计（design.md「适配层契约 2」）：
// - 渲染层与共享层手里的路径一律是 file:// URL（Android 习惯），主进程负责与系统路径互转；
// - 只允许 documents/、cache/、secrets/（密钥）三棵子树，越界抛 PATH_OUTSIDE_ROOT；
// - 同时接受裸绝对路径：导入旧备份时 payload 里可能带历史平台的绝对路径，
//   调用方会先重写，这里作为兜底归一，但**仍然要过边界校验**。
//
// 零 Electron 依赖：主进程与 Node 测试共用同一份实现。
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PATH_OUTSIDE_ROOT = 'PATH_OUTSIDE_ROOT';

export class PathOutsideRootError extends Error {
  constructor(uri) {
    // 故意不把绝对路径写进 message：错误可能被渲染层展示/记录，避免泄露系统路径细节。
    super('Path is outside the allowed roots');
    this.name = 'PathOutsideRootError';
    this.code = PATH_OUTSIDE_ROOT;
    this.uri = uri; // 仅主进程内部诊断用，不随 IPC 出参序列化（IPC 只回 message + code）。
  }
}

// 判断 child 是否位于 parent 之下（含 parent 本身）。用 path.relative 比较，避免
// 「C:\data\documents-evil」被 startsWith('C:\data\documents') 误判为子路径。
export function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// uri -> 系统绝对路径。接受 file:// URL 与裸绝对路径；其余形态（http://、content://、
// 相对路径）一律拒绝——桌面端没有 SAF/content:// 概念，放行只会制造更晚的坏错误。
export function toSystemPath(uri) {
  const raw = String(uri || '');
  if (raw.startsWith('file://')) return fileURLToPath(raw);
  if (path.isAbsolute(raw)) return raw;
  throw new PathOutsideRootError(raw);
}

// 系统路径 -> 带结尾斜杠的 file:// URL。
// 尾斜杠是刻意保留的：共享层全部是 `${documentDirectory}chat-images/` 这种字符串拼接，
// 少了斜杠会拼出 .../documentschat-images/（design.md「Key Decisions」）。
export function toFileUrl(systemPath, { trailingSlash = false } = {}) {
  const url = pathToFileURL(systemPath).href;
  if (!trailingSlash) return url;
  return url.endsWith('/') ? url : `${url}/`;
}

// 创建边界解析器：roots 是若干允许根目录（绝对系统路径）。
export function createPathResolver(roots) {
  const allowed = roots.map(root => path.resolve(root));
  return {
    roots: allowed,
    // 解析并校验；返回系统绝对路径。
    resolve(uri) {
      const resolved = path.resolve(toSystemPath(uri));
      if (!allowed.some(root => isInside(root, resolved))) {
        throw new PathOutsideRootError(String(uri || ''));
      }
      return resolved;
    },
    isInside: uri => {
      try {
        const resolved = path.resolve(toSystemPath(uri));
        return allowed.some(root => isInside(root, resolved));
      } catch (error) {
        return false;
      }
    },
  };
}
