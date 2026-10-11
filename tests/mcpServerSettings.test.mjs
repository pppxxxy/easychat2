// 内置 MCP Server 设置存储域：默认值、归一化、patch 语义与密钥通道。
//
// 回归重点（三条都是安全边界）：
//  1) 默认必须是「关着 + 仅本机 + 只开只读」——放宽默认值等于默认对外暴露工具；
//  2) 端口/范围/档位非法值必须归一，不能把用户手输的怪值写进设置；
//  3) token 必须走密钥通道（io 的 setJsonWithSecrets → Keystore），不能明文落盘。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const presetEnv = require.resolve('@babel/preset-env');

const store = new Map();
const secretCalls = { reads: 0, writes: 0 };

const AsyncStorage = {
  getItem: async key => (store.has(key) ? store.get(key) : null),
  setItem: async (key, value) => { store.set(key, value); },
  removeItem: async key => { store.delete(key); },
  getAllKeys: async () => [...store.keys()],
};

const ioStub = {
  readJson: async (key, fallback) => {
    try {
      const raw = await AsyncStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (error) {
      return fallback;
    }
  },
  readJsonStatus: async key => {
    try {
      const raw = await AsyncStorage.getItem(key);
      if (raw === null || raw === undefined) return { status: 'missing' };
      return { status: 'ok', value: JSON.parse(raw) };
    } catch (error) {
      return { status: 'corrupt' };
    }
  },
  // 密钥通道：计数并原样存取（真实实现把值搬进 Keystore，盘上只留引用）。
  readJsonWithSecrets: async (key, fallback) => {
    secretCalls.reads += 1;
    return ioStub.readJson(key, fallback);
  },
  setJsonWithSecrets: async (key, payload) => {
    secretCalls.writes += 1;
    await AsyncStorage.setItem(key, JSON.stringify(payload));
    return payload;
  },
  readJsonStatusWithSecrets: async key => ioStub.readJsonStatus(key),
  utf8ByteLength: text => Buffer.byteLength(String(text || ''), 'utf8'),
  createMutationQueue: () => {
    let single = Promise.resolve();
    const buckets = new Map();
    return {
      enqueue(task, key = '') {
        const bucket = String(key || '');
        const tail = bucket ? (buckets.get(bucket) || Promise.resolve()) : single;
        const next = tail.then(task, task);
        if (bucket) buckets.set(bucket, next.catch(() => {}));
        else single = next.catch(() => {});
        return next;
      },
      settle() {
        const tails = [single, ...buckets.values()];
        return Promise.all(tails.map(tail => tail.catch(() => {}))).then(() => undefined);
      },
    };
  },
  CORRUPT_BACKUP_SUFFIX: '__corrupt_backup',
  backupCorruptValue: async () => {},
  readLargeAsyncStorageValue: async () => null,
  getSqliteModule: () => null,
};

const sourcePath = path.resolve('src/storage/settings.js');
const SETTINGS_DIR = path.resolve('src/storage/settings');

function loadSettingsModule(absPath) {
  const cached = Module._cache[absPath];
  if (cached) return cached.exports;
  const code = babel.transformSync(fs.readFileSync(absPath, 'utf8'), {
    babelrc: false,
    configFile: false,
    filename: absPath,
    presets: [[presetEnv, { targets: { node: 'current' }, modules: 'commonjs' }]],
  }).code;
  const mod = new Module(absPath);
  mod.filename = absPath;
  mod.paths = Module._nodeModulePaths(path.dirname(absPath));
  Module._cache[absPath] = mod;
  try {
    mod._compile(code, absPath);
  } catch (error) {
    delete Module._cache[absPath];
    throw error;
  }
  return mod.exports;
}

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === '@react-native-async-storage/async-storage') return AsyncStorage;
  if (request.endsWith('/io.js')) return ioStub;
  if (parent && parent.filename && request.startsWith('.')) {
    const resolved = path.resolve(path.dirname(parent.filename), request);
    if (resolved.startsWith(`${SETTINGS_DIR}${path.sep}`) && fs.existsSync(resolved)) {
      return loadSettingsModule(resolved);
    }
  }
  return originalLoad.call(this, request, parent, isMain);
};
const transformed = babel.transformSync(fs.readFileSync(sourcePath, 'utf8'), {
  babelrc: false,
  configFile: false,
  filename: sourcePath,
  presets: [[presetEnv, { targets: { node: 'current' }, modules: 'commonjs' }]],
}).code;
const runtime = new Module(sourcePath);
runtime.filename = sourcePath;
runtime.paths = Module._nodeModulePaths(path.dirname(sourcePath));
runtime._compile(transformed, sourcePath);
Module._load = originalLoad;

const settings = runtime.exports;
const KEY = '@easychat2_mcp_server';
const DEFAULTS = {
  enabled: false,
  scope: 'loopback',
  port: 8737,
  mcpToken: '',
  tiers: { read: true, write: false, exec: false },
};

test('默认值：关着 + 仅本机 + 只开只读（这三条就是安全边界）', async () => {
  store.clear();
  assert.deepEqual(await settings.getMcpServerSettings(), DEFAULTS);
  assert.equal(settings.MCP_SERVER_PORT_DEFAULT, 8737);
  assert.deepEqual(settings.MCP_SERVER_SCOPES, ['loopback', 'lan']);
  assert.ok(settings.MCP_SERVER_PORT_DEFAULT !== 8080, '不占本地 API 服务的默认端口');
  assert.ok(settings.MCP_SERVER_PORT_DEFAULT !== 8686, '不占 JS SDK 的默认基址端口');
});

test('归一化：非法范围/端口/档位回退，合法值保留', async () => {
  store.set(KEY, JSON.stringify({
    enabled: 'yes',
    scope: 'public',
    port: 80,
    mcpToken: '  tok  ',
    tiers: { read: true, write: true, exec: 1 },
  }));
  const loaded = await settings.getMcpServerSettings();
  assert.equal(loaded.enabled, false, '只有显式 true 才算开');
  assert.equal(loaded.scope, 'loopback', '未登记的范围回退回环');
  assert.equal(loaded.port, 8737, '低于 1024 的端口回退默认');
  assert.equal(loaded.mcpToken, 'tok', 'token 去空白');
  assert.deepEqual(loaded.tiers, { read: true, write: true, exec: false });

  for (const [raw, expected] of [[1023, 8737], [65536, 8737], [0, 8737], ['abc', 8737], [1024, 1024], [65535, 65535]]) {
    store.set(KEY, JSON.stringify({ port: raw }));
    assert.equal((await settings.getMcpServerSettings()).port, expected, `port=${String(raw)}`);
  }
  store.set(KEY, JSON.stringify({ scope: 'lan' }));
  assert.equal((await settings.getMcpServerSettings()).scope, 'lan');
  store.set(KEY, '{ not json');
  assert.deepEqual(await settings.getMcpServerSettings(), DEFAULTS, '损坏回退默认');
  store.clear();
});

test('patch：改档位不重置端口与 token，回写 token 不重置开关（核心回归）', async () => {
  store.clear();
  await settings.saveMcpServerSettings({ enabled: true, scope: 'lan', port: 9001, mcpToken: 'secret-token' });
  assert.deepEqual(await settings.getMcpServerSettings(), {
    enabled: true, scope: 'lan', port: 9001, mcpToken: 'secret-token', tiers: DEFAULTS.tiers,
  });

  // 用户点开「允许写入」
  const afterTier = await settings.patchMcpServerSettings({ tiers: { read: true, write: true, exec: false } });
  assert.equal(afterTier.port, 9001, '改档位不得重置端口');
  assert.equal(afterTier.mcpToken, 'secret-token', '改档位不得丢 token');
  assert.equal(afterTier.enabled, true);

  // 启动成功后回写原生生成的 token
  const afterToken = await settings.patchMcpServerSettings({ mcpToken: 'generated' });
  assert.equal(afterToken.enabled, true, '回写 token 不得把开关归回 false');
  assert.equal(afterToken.scope, 'lan');
  assert.equal(afterToken.tiers.write, true);
  assert.equal(afterToken.mcpToken, 'generated');

  // 对比：整体写只带单字段就会回落默认（说明写入方必须走 patch）
  const naive = await settings.saveMcpServerSettings({ enabled: true });
  assert.equal(naive.mcpToken, '', '整体写清空 token');
  assert.equal(naive.port, 8737);
  store.clear();
});

test('patch：无补丁 / 非法补丁不破坏现值', async () => {
  store.clear();
  await settings.patchMcpServerSettings({ enabled: true, port: 9111, mcpToken: 't' });
  assert.deepEqual(await settings.patchMcpServerSettings(), {
    enabled: true, scope: 'loopback', port: 9111, mcpToken: 't', tiers: DEFAULTS.tiers,
  });
  const bad = await settings.patchMcpServerSettings(null);
  assert.equal(bad.port, 9111);
  const badValue = await settings.patchMcpServerSettings({ port: 'nope' });
  assert.equal(badValue.port, 8737, '非法值归一为默认');
  assert.equal(badValue.enabled, true, '其余字段不受影响');
  store.clear();
});

test('token 必须走密钥通道（明文落盘等于把工具执行权写进普通存储）', async () => {
  store.clear();
  secretCalls.reads = 0;
  secretCalls.writes = 0;
  await settings.saveMcpServerSettings({ enabled: true, mcpToken: 'keystore-me' });
  await settings.getMcpServerSettings();
  assert.ok(secretCalls.writes >= 1, '写盘走 setJsonWithSecrets');
  assert.ok(secretCalls.reads >= 1, '读盘走 readJsonWithSecrets');
  // 字段名必须是 secretStore.SECRET_FIELDS 里已登记的 mcpToken——换个名字就悄悄失去 Keystore 保护。
  const source = fs.readFileSync(path.resolve('src/storage/settings/mcpServer.js'), 'utf8');
  assert.match(source, /mcpToken:/);
  assert.ok(!/^\s*token:/m.test(source), '不得用未登记的 token 字段名（那是明文落盘）');
  store.clear();
});
