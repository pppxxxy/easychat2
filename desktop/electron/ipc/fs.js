// 文件能力（design.md「适配层契约 2」）：expo-file-system/legacy 的异步面 +
// expo-file-system 新 API 的**同步** File/FileHandle 面。
//
// 为什么必须同时提供同步面：共享层 src/storage/backup.js / backupRead.js 对
// `new File(uri)` 的调用是同步的（file.exists / file.open() / handle.readBytes(n) /
// handle.writeBytes(bytes) / file.write(buffer) / file.create() / file.delete()）。
// 这不是笔误——expo-file-system 的新 API 在 Android 上是 JSI 同步调用，本来就阻塞
// JS 线程。桌面侧用 sendSync + 同步 fs 调用镜像同一语义，读分片大小（8MB）与行为不变。
// 设计稿 IPC 表只列了异步 fs:openHandle/readBytes/closeHandle，S1 按真实消费点补齐
// 同步变体（preload 侧走 ipcRenderer.sendSync，主进程侧走 node:fs *Sync）。
//
// 边界：所有 uri 一律经 paths.js 校验（documents/cache 两棵子树），越界抛
// PATH_OUTSIDE_ROOT，绝不把系统绝对路径回传渲染层。
import fs from 'node:fs';
import path from 'node:path';
import { createPathResolver, toFileUrl } from '../paths.js';

const MAX_HANDLES = 64;

export function createFsService({ documentsRoot, cacheRoot, fetchImpl = globalThis.fetch } = {}) {
  if (!documentsRoot || !cacheRoot) throw new Error('createFsService: documentsRoot/cacheRoot required');
  const resolver = createPathResolver([documentsRoot, cacheRoot]);
  const handles = new Map();
  let nextHandleId = 1;

  const resolve = uri => resolver.resolve(uri);

  function openHandle(uri) {
    if (handles.size >= MAX_HANDLES) throw new Error('too many open file handles');
    const filePath = resolve(uri);
    // 'r+'：既读又写（FileHandle 同时支持 readBytes 与 writeBytes，对齐 RandomAccessFile）。
    // 文件不存在时由调用方先 create（共享层写路径正是 create → open 的顺序）。
    const fd = fs.openSync(filePath, 'r+');
    const handleId = nextHandleId;
    nextHandleId += 1;
    handles.set(handleId, { fd, offset: 0, filePath });
    return { handleId, size: fs.fstatSync(fd).size };
  }

  function readBytes(handleId, length) {
    const handle = handles.get(handleId);
    if (!handle) throw new Error(`unknown handle: ${handleId}`);
    const want = Math.max(1, Math.floor(Number(length) || 0));
    const buffer = Buffer.alloc(want);
    const read = fs.readSync(handle.fd, buffer, 0, want, handle.offset);
    handle.offset += read;
    // 返回精确长度的 Uint8Array（structured clone 经 IPC 传输后仍是 Uint8Array）。
    return new Uint8Array(buffer.buffer, buffer.byteOffset, read);
  }

  function writeBytes(handleId, bytes) {
    const handle = handles.get(handleId);
    if (!handle) throw new Error(`unknown handle: ${handleId}`);
    const buffer = Buffer.from(bytes.buffer ? bytes.buffer : bytes, bytes.byteOffset || 0, bytes.byteLength ?? bytes.length);
    const written = fs.writeSync(handle.fd, buffer, 0, buffer.length, handle.offset);
    handle.offset += written;
    return written;
  }

  function closeHandle(handleId) {
    const handle = handles.get(handleId);
    if (!handle) return;
    handles.delete(handleId);
    try { fs.closeSync(handle.fd); } catch (error) {}
  }

  function closeAll() {
    for (const id of [...handles.keys()]) closeHandle(id);
  }

  return {
    resolver,
    // ---- 异步面（expo-file-system/legacy）----
    async stat(uri) {
      const filePath = resolve(uri);
      try {
        const info = fs.statSync(filePath);
        return {
          exists: true,
          uri: toFileUrl(filePath),
          size: info.isDirectory() ? undefined : info.size,
          isDirectory: info.isDirectory(),
          modificationTime: info.mtimeMs / 1000,
        };
      } catch (error) {
        if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return { exists: false };
        throw error;
      }
    },
    async read(uri, encoding = 'utf8') {
      const filePath = resolve(uri);
      if (encoding === 'base64') return fs.readFileSync(filePath).toString('base64');
      return fs.readFileSync(filePath, 'utf8');
    },
    async write(uri, data, encoding = 'utf8') {
      const filePath = resolve(uri);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      if (encoding === 'base64') fs.writeFileSync(filePath, Buffer.from(String(data), 'base64'));
      else fs.writeFileSync(filePath, String(data ?? ''), 'utf8');
    },
    async mkdir(uri, intermediates = false) {
      fs.mkdirSync(resolve(uri), { recursive: !!intermediates });
    },
    async readDir(uri) {
      return fs.readdirSync(resolve(uri));
    },
    async copy(from, to) {
      const source = resolve(from);
      const target = resolve(to);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
    },
    async move(from, to) {
      const source = resolve(from);
      const target = resolve(to);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.renameSync(source, target);
    },
    async delete(uri, idempotent = true) {
      const target = resolve(uri);
      try {
        fs.rmSync(target, { recursive: true, force: true });
      } catch (error) {
        if (!idempotent) throw error;
      }
    },
    async download(url, to) {
      const target = resolve(to);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const response = await fetchImpl(String(url));
      if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      fs.writeFileSync(target, buffer);
      return { uri: toFileUrl(target), status: response.status };
    },
    async freeSpace() {
      // Node 22 没有跨平台 free-space API（statfs 仅部分平台）；返回 0 表示「未知」，
      // 共享层把 0 当无信息处理而不是「没空间」。
      return 0;
    },
    // ---- 同步面（expo-file-system 新 API 的 File/FileHandle）----
    sync: {
      stat(uri) {
        const filePath = resolve(uri);
        try {
          const info = fs.statSync(filePath);
          return { exists: true, size: info.isDirectory() ? null : info.size, isDirectory: info.isDirectory() };
        } catch (error) {
          if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return { exists: false, size: null };
          throw error;
        }
      },
      openHandle,
      readBytes,
      writeBytes,
      closeHandle,
      create(uri, { intermediates = false, overwrite = false } = {}) {
        const filePath = resolve(uri);
        if (intermediates) fs.mkdirSync(path.dirname(filePath), { recursive: true });
        if (!overwrite) {
          try {
            fs.accessSync(filePath);
            throw new Error('file already exists');
          } catch (error) {
            if (error && error.code !== 'ENOENT') throw error;
          }
        }
        fs.closeSync(fs.openSync(filePath, 'w'));
      },
      writeAll(uri, bytes) {
        const filePath = resolve(uri);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        const buffer = Buffer.from(bytes.buffer ? bytes.buffer : bytes, bytes.byteOffset || 0, bytes.byteLength ?? bytes.length);
        fs.writeFileSync(filePath, buffer);
      },
      readAll(uri) {
        return fs.readFileSync(resolve(uri));
      },
      delete(uri) {
        // 与 expo File.delete() 一致：文件不存在时抛错（不是 no-op）。
        fs.unlinkSync(resolve(uri));
      },
    },
    closeAll,
  };
}

export function registerFsIpc(ipcMain, service) {
  const handle = (channel, fn) => ipcMain.handle(channel, (event, ...args) => fn(...args));
  handle('fs:stat', uri => service.stat(uri));
  handle('fs:read', (uri, encoding) => service.read(uri, encoding));
  handle('fs:write', (uri, data, encoding) => service.write(uri, data, encoding));
  handle('fs:mkdir', (uri, intermediates) => service.mkdir(uri, intermediates));
  handle('fs:readDir', uri => service.readDir(uri));
  handle('fs:copy', (from, to) => service.copy(from, to));
  handle('fs:move', (from, to) => service.move(from, to));
  handle('fs:delete', (uri, idempotent) => service.delete(uri, idempotent));
  handle('fs:download', (url, to) => service.download(url, to));
  handle('fs:freeSpace', () => service.freeSpace());
  handle('fs:openHandle', uri => service.sync.openHandle(uri));
  handle('fs:readBytes', (handleId, length) => service.sync.readBytes(handleId, length));
  handle('fs:closeHandle', handleId => service.sync.closeHandle(handleId));

  // 同步通道（renderer 的 File/FileHandle 语义需要；见文件头注释）。
  const sync = (channel, fn) => ipcMain.on(channel, (event, ...args) => {
    try {
      event.returnValue = { ok: true, value: fn(...args) };
    } catch (error) {
      // 同步 IPC 不能抛 Error 对象回渲染层：序列化为 code/message。
      event.returnValue = { ok: false, code: (error && error.code) || 'FS_ERROR', message: String((error && error.message) || error) };
    }
  });
  sync('fs:sync:stat', uri => service.sync.stat(uri));
  sync('fs:sync:openHandle', uri => service.sync.openHandle(uri));
  sync('fs:sync:readBytes', (handleId, length) => service.sync.readBytes(handleId, length));
  sync('fs:sync:writeBytes', (handleId, bytes) => service.sync.writeBytes(handleId, bytes));
  sync('fs:sync:closeHandle', handleId => service.sync.closeHandle(handleId));
  sync('fs:sync:create', (uri, options) => service.sync.create(uri, options));
  sync('fs:sync:writeAll', (uri, bytes) => service.sync.writeAll(uri, bytes));
  sync('fs:sync:readAll', uri => service.sync.readAll(uri));
  sync('fs:sync:delete', uri => service.sync.delete(uri));
}
