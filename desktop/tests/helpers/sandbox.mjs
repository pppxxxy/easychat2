// 测试沙箱：临时目录 + 直接接线的主进程服务 + 假桥。
//
// 关键点：假桥暴露的**正是** preload 暴露的同一套方法名与参数形状（kv/fs/secret），
// 所以这些测试验证的不是「一个假实现」，而是「渲染层适配器 + 主进程服务」的真实契约。
// 不依赖 Electron：所有 ipc/*.js 都是零 Electron 依赖的工厂。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createKvStore } from '../../electron/ipc/kv.js';
import { createFsService } from '../../electron/ipc/fs.js';
import { createSecretStore } from '../../electron/ipc/secret.js';
import { toFileUrl } from '../../electron/paths.js';

export function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easychat2-desktop-'));
  const documentsRoot = path.join(root, 'documents');
  const cacheRoot = path.join(root, 'cache');
  const kvRoot = path.join(root, 'kv');
  const secretsRoot = path.join(root, 'secrets');
  for (const dir of [documentsRoot, cacheRoot, kvRoot, secretsRoot]) fs.mkdirSync(dir, { recursive: true });

  const kvStore = createKvStore({ root: kvRoot });
  const fsService = createFsService({ documentsRoot, cacheRoot });
  const recordDiagnostic = [];
  const safeStorageUnavailable = {
    isEncryptionAvailable: () => false,
    encryptString: () => {
      throw new Error('unavailable');
    },
    decryptString: () => {
      throw new Error('unavailable');
    },
  };
  const secretStore = createSecretStore({
    root: secretsRoot,
    safeStorage: safeStorageUnavailable,
    recordDiagnostic: (...args) => recordDiagnostic.push(args),
  });

  const documentDirectory = toFileUrl(documentsRoot, { trailingSlash: true });
  const cacheDirectory = toFileUrl(cacheRoot, { trailingSlash: true });

  const bridge = {
    app: {
      paths: { documentDirectory, cacheDirectory },
      info: async () => ({ version: 'test', platform: 'windows', documents: documentDirectory, cache: cacheDirectory }),
    },
    kv: {
      get: key => kvStore.get(key),
      set: (key, value) => kvStore.set(key, value),
      remove: key => kvStore.remove(key),
      keys: () => kvStore.keys(),
      multiGet: keys => kvStore.multiGet(keys),
      multiSet: entries => kvStore.multiSet(entries),
      multiRemove: keys => kvStore.multiRemove(keys),
    },
    fs: {
      stat: uri => fsService.stat(uri),
      read: (uri, encoding) => fsService.read(uri, encoding),
      write: (uri, data, encoding) => fsService.write(uri, data, encoding),
      mkdir: (uri, intermediates) => fsService.mkdir(uri, intermediates),
      readDir: uri => fsService.readDir(uri),
      copy: (from, to) => fsService.copy(from, to),
      move: (from, to) => fsService.move(from, to),
      delete: (uri, idempotent) => fsService.delete(uri, idempotent),
      download: (url, to) => fsService.download(url, to),
      freeSpace: () => fsService.freeSpace(),
      openHandle: uri => fsService.sync.openHandle(uri),
      readBytes: (handleId, length) => fsService.sync.readBytes(handleId, length),
      closeHandle: handleId => fsService.sync.closeHandle(handleId),
      sync: {
        stat: uri => fsService.sync.stat(uri),
        openHandle: uri => fsService.sync.openHandle(uri),
        readBytes: (handleId, length) => fsService.sync.readBytes(handleId, length),
        writeBytes: (handleId, bytes) => fsService.sync.writeBytes(handleId, bytes),
        closeHandle: handleId => fsService.sync.closeHandle(handleId),
        create: (uri, options) => fsService.sync.create(uri, options),
        writeAll: (uri, bytes) => fsService.sync.writeAll(uri, bytes),
        readAll: uri => fsService.sync.readAll(uri),
        delete: uri => fsService.sync.delete(uri),
      },
    },
    secret: {
      available: () => secretStore.available(),
      get: id => secretStore.getItemAsync(id),
      set: (id, value) => secretStore.setItemAsync(id, value),
      remove: id => secretStore.deleteItemAsync(id),
    },
  };

  return {
    root,
    documentsRoot,
    cacheRoot,
    kvRoot,
    secretsRoot,
    kvStore,
    fsService,
    secretStore,
    recordDiagnostic,
    bridge,
    documentDirectory,
    cacheDirectory,
    cleanup() {
      fsService.closeAll();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
