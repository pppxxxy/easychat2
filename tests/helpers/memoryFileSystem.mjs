// 内存版 expo-file-system/legacy（测试用）。URI 语义，接口形状与真实现一致。
//
// 两个必须照真的细节（W7 spike 实测踩出来的，别"简化"掉）：
// 1. 目录带不带尾斜杠都要能查到（真实实现是路径，不是字符串前缀匹配）；
// 2. 按 text 写进去的文件必须能按 base64 读回来（反之亦然）——字节是唯一真相，
//    两种编码都是它的视图。不照这一点，git 会把文件读成空 blob。
import { Buffer } from 'buffer';

export function createMemoryFileSystem() {
  const nodes = new Map(); // uri -> { type: 'dir' | 'file', bytes?, mtime }
  const lookup = uri => nodes.get(String(uri)) || nodes.get(`${String(uri)}/`);
  const ensureDirs = uri => {
    const value = String(uri);
    const parts = value.split('/').filter(Boolean);
    let current = '';
    for (let i = 0; i < parts.length; i += 1) {
      current += `/${parts[i]}`;
      const isLast = i === parts.length - 1;
      const key = isLast && !value.endsWith('/') ? current : `${current}/`;
      if (!nodes.has(key)) nodes.set(key, { type: 'dir', mtime: Date.now() });
    }
  };
  return {
    nodes,
    async getInfoAsync(uri) {
      const node = lookup(uri);
      if (!node) return { exists: false };
      if (node.type === 'dir') return { exists: true, isDirectory: true, modificationTime: node.mtime };
      return { exists: true, isDirectory: false, size: node.bytes.length, modificationTime: node.mtime };
    },
    async readAsStringAsync(uri, options) {
      const node = lookup(uri);
      if (!node || node.type !== 'file') {
        const error = new Error(`ENOENT: ${uri}`);
        error.code = 'ENOENT';
        throw error;
      }
      return options && options.encoding === 'base64'
        ? node.bytes.toString('base64')
        : node.bytes.toString('utf8');
    },
    async writeAsStringAsync(uri, text, options) {
      const value = String(text);
      const bytes = options && options.encoding === 'base64'
        ? Buffer.from(value, 'base64')
        : Buffer.from(value, 'utf8');
      nodes.set(String(uri), { type: 'file', bytes, mtime: Date.now() });
    },
    async readDirectoryAsync(uri) {
      const value = String(uri);
      const base = value.endsWith('/') ? value : `${value}/`;
      const names = new Set();
      for (const key of nodes.keys()) {
        if (!key.startsWith(base) || key === base) continue;
        names.add(key.slice(base.length).split('/')[0]);
      }
      return [...names];
    },
    async makeDirectoryAsync(uri, options = {}) {
      const value = String(uri);
      if (options.intermediates) {
        ensureDirs(value.endsWith('/') ? value : `${value}/`);
        return;
      }
      nodes.set(value.endsWith('/') ? value : `${value}/`, { type: 'dir', mtime: Date.now() });
    },
    async deleteAsync(uri, options = {}) {
      const value = String(uri);
      const dirKey = value.endsWith('/') ? value : `${value}/`;
      let removed = false;
      for (const existing of [...nodes.keys()]) {
        if (existing === value || existing === dirKey || existing.startsWith(dirKey)) {
          nodes.delete(existing);
          removed = true;
        }
      }
      if (!removed && !options.idempotent) throw new Error(`ENOENT: ${uri}`);
    },
    async moveAsync({ from, to }) {
      const node = nodes.get(String(from)) || nodes.get(`${String(from)}/`);
      if (!node) throw new Error(`ENOENT: ${from}`);
      nodes.delete(String(from));
      nodes.set(String(to), node);
    },
  };
}
