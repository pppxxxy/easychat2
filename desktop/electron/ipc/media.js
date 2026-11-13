// easychat2-media:// 协议（design.md「适配层契约 5」）：渲染进程加载本地媒体。
//
// 为什么不用 file://：渲染进程直接加载 file:// 需要关闭 web 安全（webSecurity:false），
// 代价过高；自定义协议可以在主进程做目录白名单校验，天然只暴露 documents/ 子树。
//
// URL 形态：easychat2-media://media/chat-images/image-123.jpg
// 路径部分会 percent-decode 后拼到 documents/，再经 paths.js 校验（.. 段拒绝）。
import fs from 'node:fs';
import path from 'node:path';
import { createPathResolver, PATH_OUTSIDE_ROOT } from '../paths.js';

const MIME_BY_EXT = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

// 纯函数：把协议 URL 解析到 documents/ 下的系统路径。越界返回 null（handler 回 403）。
export function createMediaHandler({ documentsRoot } = {}) {
  if (!documentsRoot) throw new Error('createMediaHandler: documentsRoot is required');
  const resolver = createPathResolver([documentsRoot]);

  function toSystemPath(rawUrl) {
    let url;
    try {
      url = new URL(String(rawUrl));
    } catch (error) {
      return null;
    }
    if (url.protocol !== 'easychat2-media:') return null;
    // host 部分是 'media'（或空），真正的相对路径在 pathname 里。
    const relative = decodeURIComponent(url.pathname || '').replace(/^\/+/, '');
    if (!relative) return null;
    const uri = `${documentsRoot.replace(/[\\/]+$/, '')}/${relative}`;
    try {
      return resolver.resolve(uri);
    } catch (error) {
      if (error && error.code === PATH_OUTSIDE_ROOT) return null;
      throw error;
    }
  }

  async function handler(request) {
    const filePath = toSystemPath(request.url);
    if (!filePath) return new Response('Forbidden', { status: 403 });
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch (error) {
      return new Response('Not Found', { status: 404 });
    }
    if (!stat.isFile()) return new Response('Not Found', { status: 404 });
    const mime = MIME_BY_EXT[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    const body = fs.readFileSync(filePath);
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': mime,
        'Content-Length': String(stat.size),
        // 媒体会被回收器删除：长缓存会导致恢复后仍显示旧图（design.md 契约 5）。
        'Cache-Control': 'no-cache',
      },
    });
  }

  return { handler, toSystemPath };
}
