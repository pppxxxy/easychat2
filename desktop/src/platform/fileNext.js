// expo-file-system（新 API）的 File/FileHandle 适配（design.md「适配层契约 2」末段）。
//
// 同步语义来源：共享层对 File 的调用**不带 await**（src/storage/backup.js 的
// create → open → writeBytes，src/storage/backupRead.js 的 open → readBytes 分片）。
// expo 新 API 在 Android 上是 JSI 同步调用；桌面侧用 sendSync 镜像同一语义，
// 分片大小（8MB）与「峰值内存 = 一片」的性质不变。
//
// 支持面（逐项对照共享层真实用到的成员）：
//   new File(uri)、file.exists、file.size、file.open()、file.create({intermediates, overwrite})、
//   file.write(Uint8Array|string)、file.write(base64, {encoding:'base64'})、file.delete()、file.text()
//   handle.readBytes(n) → Uint8Array、handle.writeBytes(Uint8Array)、handle.offset、handle.close()
import { createLazyDefault } from './bridge.js';

const encoder = new TextEncoder();

export function createFileNext(bridge) {
  const sync = bridge.fs.sync;

  class DesktopFileHandle {
    constructor(uri) {
      this.uri = uri;
      const opened = sync.openHandle(uri);
      this.handleId = opened.handleId;
      this.size = opened.size;
      this.offset = 0;
      this.closed = false;
    }
    readBytes(length) {
      if (this.closed) throw new Error('file handle is closed');
      const bytes = sync.readBytes(this.handleId, length);
      this.offset += bytes.length;
      return bytes;
    }
    writeBytes(bytes) {
      if (this.closed) throw new Error('file handle is closed');
      const written = sync.writeBytes(this.handleId, bytes);
      this.offset += written;
      return written;
    }
    close() {
      if (this.closed) return;
      this.closed = true;
      sync.closeHandle(this.handleId);
    }
  }

  class DesktopFile {
    constructor(uri) {
      this.uri = String(uri);
    }
    get exists() {
      return sync.stat(this.uri).exists;
    }
    get size() {
      const info = sync.stat(this.uri);
      if (!info.exists || info.isDirectory) return 0;
      return typeof info.size === 'number' ? info.size : 0;
    }
    create(options = {}) {
      sync.create(this.uri, {
        intermediates: !!options.intermediates,
        overwrite: !!options.overwrite,
      });
      return this;
    }
    open() {
      return new DesktopFileHandle(this.uri);
    }
    write(data, options = {}) {
      if (data instanceof Uint8Array) {
        sync.writeAll(this.uri, data);
        return;
      }
      if (options && options.encoding === 'base64') {
        // base64 -> bytes -> 整块写；共享层只在 SAF 场景用这个形态（桌面不经过），保守支持。
        const binary = atob(String(data));
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        sync.writeAll(this.uri, bytes);
        return;
      }
      sync.writeAll(this.uri, encoder.encode(String(data ?? '')));
    }
    text() {
      return new TextDecoder().decode(sync.readAll(this.uri));
    }
    delete() {
      sync.delete(this.uri);
    }
  }

  return { File: DesktopFile };
}

export default createLazyDefault(createFileNext);
