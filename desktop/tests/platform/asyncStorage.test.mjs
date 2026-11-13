// AsyncStorage 适配 + 键值仓（design.md「适配层契约 1」）行为测试。
//
// 覆盖：
// - 渲染层适配器与主进程仓的完整契约（写读、删除、keys、multi*）；
// - 原子写入：rename 失败时旧值仍可读、临时文件被清理（写入中断不产生半截 JSON）；
// - 损坏值：JSON 解析失败必须抛错（上层据此判 corrupt），而不是静默返回 null。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { makeSandbox } from '../helpers/sandbox.mjs';
import { createAsyncStorage } from '../../src/platform/asyncStorage.js';
import { createKvStore } from '../../electron/ipc/kv.js';

test('AsyncStorage 适配：读写 / 删除 / keys / multi 语义与存储层一致', async () => {
  const sandbox = makeSandbox();
  try {
    const storage = createAsyncStorage(sandbox.bridge);
    assert.equal(await storage.getItem('missing'), null, '缺失键返回 null');

    await storage.setItem('@easychat2_demo', '{"a":1}');
    assert.equal(await storage.getItem('@easychat2_demo'), '{"a":1}');

    await storage.multiSet([['k1', 'v1'], ['k2', 'v2']]);
    assert.deepEqual(await storage.multiGet(['k1', 'k2', 'nope']), [['k1', 'v1'], ['k2', 'v2'], ['nope', null]]);

    const keys = await storage.getAllKeys();
    assert.ok(keys.includes('@easychat2_demo') && keys.includes('k1') && keys.includes('k2'));

    await storage.multiRemove(['k1', 'k2']);
    assert.equal(await storage.getItem('k1'), null);
    assert.ok(!(await storage.getAllKeys()).includes('k1'));

    await storage.removeItem('@easychat2_demo');
    assert.equal(await storage.getItem('@easychat2_demo'), null);
  } finally {
    sandbox.cleanup();
  }
});

test('键值仓原子性：rename 失败时旧值仍可读，临时文件不残留', () => {
  const sandbox = makeSandbox();
  try {
    const root = path.join(sandbox.root, 'kv-atomic');
    const store = createKvStore({ root });
    store.set('session::1', 'old-value');

    // 模拟「写到一半磁盘满」：tmp 写成功、rename 失败。
    let failRename = true;
    const flakyFs = new Proxy(fs, {
      get(target, property) {
        if (property === 'renameSync' && failRename) {
          return () => {
            failRename = false;
            const error = new Error('disk full');
            error.code = 'ENOSPC';
            throw error;
          };
        }
        return target[property];
      },
    });
    const flakyStore = createKvStore({ root, fsImpl: flakyFs });
    assert.throws(() => flakyStore.set('session::1', 'new-value'), /disk full/);

    assert.equal(store.get('session::1'), 'old-value', '写入中断后旧值必须仍可读（不存在半截 JSON）');
    const leftovers = fs.readdirSync(root).filter(name => name.endsWith('.tmp'));
    assert.deepEqual(leftovers, [], '临时文件必须被清理');
  } finally {
    sandbox.cleanup();
  }
});

test('键值仓：损坏的 JSON 抛错（上层据此判 corrupt 并备份原文件）', () => {
  const sandbox = makeSandbox();
  try {
    const root = path.join(sandbox.root, 'kv-corrupt');
    fs.mkdirSync(root, { recursive: true });
    const store = createKvStore({ root });
    store.set('k', 'ok');
    // 找到哈希文件名并写坏它。
    const files = fs.readdirSync(root).filter(name => name.endsWith('.json'));
    assert.equal(files.length, 1);
    fs.writeFileSync(path.join(root, files[0]), '{ not json', 'utf8');
    assert.throws(() => store.get('k'), /JSON/);
    // getAllKeys 对损坏键跳过，不拖垮整个键表。
    assert.deepEqual(store.keys(), []);
  } finally {
    sandbox.cleanup();
  }
});
