// MCP 自定义请求头的**真实存储链路**行为测试（回归 2026-10-11 逐行审查 P0：真密钥明文落盘）。
//
// 为什么不能用 tests/mcpServers.test.mjs 里现成的加载器：那里的 ioStub 是**假对象**——
// setJsonWithSecrets / readJsonWithSecrets 直接把 payload JSON.stringify 进内存 Map，
// 完全绕过 secretStore。于是「headers 里的 Authorization token 明文写进 AsyncStorage」
// 这个缺陷在门禁全绿的情况下活了很久（与 tests/agentTask.test.mjs 用假对象掩盖
// agentTasks 缺陷是同一型问题）。
//
// 这个文件立的规矩：走**真 io.js + 真 secretStore.js**，只把两个原生边界
//（AsyncStorage / expo-secure-store）换成内存替身，然后断言**盘上那份原始字符串**里
// 到底有没有 token——只有看到原始串，才能证明它没落明文。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const presetEnv = require.resolve('@babel/preset-env');
const SRC_DIR = path.resolve('src');

function loadModule(absPath) {
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

// ---- 原生边界替身（只有这两个是假的，其余全真）----
const storage = new Map();
const asyncStorageMock = {
  __esModule: true,
  default: {
    getItem: async key => (storage.has(key) ? storage.get(key) : null),
    setItem: async (key, value) => { storage.set(key, String(value)); },
    removeItem: async key => { storage.delete(key); },
    multiRemove: async keys => { (Array.isArray(keys) ? keys : []).forEach(key => storage.delete(key)); },
    getAllKeys: async () => [...storage.keys()],
  },
};

const secureValues = new Map();
const secureMock = {
  __esModule: true,
  setItemAsync: async (key, value) => { secureValues.set(key, value); },
  getItemAsync: async key => (secureValues.has(key) ? secureValues.get(key) : null),
  deleteItemAsync: async key => { secureValues.delete(key); },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === '@react-native-async-storage/async-storage') return asyncStorageMock;
  if (request === 'expo-secure-store') return secureMock;
  if (request === 'expo-file-system/legacy') {
    return { __esModule: true, documentDirectory: null, getInfoAsync: async () => ({ exists: false }) };
  }
  if (request.endsWith('/i18n/index.js') || request.endsWith('/i18n/index')) {
    return { __esModule: true, tActive: key => String(key) };
  }
  if (parent && parent.filename && request.startsWith('.')) {
    const resolvedBase = path.resolve(path.dirname(parent.filename), request);
    if (resolvedBase.startsWith(`${SRC_DIR}${path.sep}`)) {
      for (const candidate of [resolvedBase, `${resolvedBase}.js`]) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return loadModule(candidate);
      }
    }
  }
  return originalLoad.call(this, request, parent, isMain);
};

const {
  MCP_SERVERS_KEY,
  getMcpServers,
  saveMcpServers,
} = loadModule(path.resolve('src/storage/settings/mcpServers.js'));

// 无 sk-/Bearer/ghp_ 前缀的随机串：脱敏正则兜不住，只能靠「根本不落盘」来保证安全。
const HEADER_TOKEN = 'zQ7headerplainsecretvalue9x';
const MCP_TOKEN = 'zQ7mcptokenplainvalue9x';

function reset() {
  storage.clear();
  secureValues.clear();
}

test('MCP 自定义请求头不明文落盘，读回时 headers 完整', async () => {
  reset();
  await saveMcpServers([{
    id: 'notes',
    name: 'Notes',
    endpoint: 'https://mcp.example.com/mcp',
    authMethod: 'token',
    mcpToken: MCP_TOKEN,
    headers: { Authorization: `Bearer ${HEADER_TOKEN}`, 'X-Api-Key': HEADER_TOKEN },
    enabled: true,
  }]);

  const raw = storage.get(MCP_SERVERS_KEY);
  assert.ok(raw, 'MCP 列表已写入存储键');
  assert.equal(raw.includes(HEADER_TOKEN), false, 'AsyncStorage 原文里不得出现请求头 token');
  assert.equal(raw.includes(`Bearer ${HEADER_TOKEN}`), false, '带 Bearer 前缀的整串同样不得出现');
  assert.equal(raw.includes(MCP_TOKEN), false, 'mcpToken 同样不得明文');
  // 键名留在盘上（排查「配了哪些头」不需要密钥），值换成安全存储引用。
  assert.ok(raw.includes('Authorization'), '请求头**键名**保留，便于排查');
  assert.ok(raw.includes('secure:v1:'), '请求头**值**换成安全存储引用');
  assert.equal(secureValues.size, 3, 'mcpToken + 两个请求头各一条安全存储记录');

  const servers = await getMcpServers();
  assert.equal(servers.length, 1);
  assert.deepEqual(
    servers[0].headers,
    { Authorization: `Bearer ${HEADER_TOKEN}`, 'X-Api-Key': HEADER_TOKEN },
    '读回时 headers 完整（不能拿到引用串）'
  );
  assert.equal(servers[0].mcpToken, MCP_TOKEN);
});

test('重复保存同一服务器不产生孤儿密钥（引用稳定）', async () => {
  reset();
  const server = {
    id: 'notes',
    name: 'Notes',
    endpoint: 'https://mcp.example.com/mcp',
    authMethod: 'token',
    mcpToken: MCP_TOKEN,
    headers: { Authorization: `Bearer ${HEADER_TOKEN}` },
  };
  await saveMcpServers([server]);
  const firstRef = JSON.parse(storage.get(MCP_SERVERS_KEY))[0].headers.Authorization;
  await saveMcpServers([{ ...server, name: 'Notes 2' }]);
  const secondRef = JSON.parse(storage.get(MCP_SERVERS_KEY))[0].headers.Authorization;
  assert.equal(firstRef, secondRef, '同一位置重复保存覆盖同一条记录');
  assert.equal(secureValues.size, 2, '不产生孤儿密钥');
});

test('旧数据里的明文请求头仍能读回（兼容），下次保存自动转引用', async () => {
  reset();
  // 模拟改造前落盘的样子：headers 整块明文。
  storage.set(MCP_SERVERS_KEY, JSON.stringify([{
    id: 'notes',
    name: 'Notes',
    endpoint: 'https://mcp.example.com/mcp',
    authMethod: 'token',
    mcpToken: MCP_TOKEN,
    headers: { Authorization: `Bearer ${HEADER_TOKEN}` },
  }]));
  const legacy = await getMcpServers();
  assert.deepEqual(legacy[0].headers, { Authorization: `Bearer ${HEADER_TOKEN}` });
  await saveMcpServers(legacy);
  assert.equal(storage.get(MCP_SERVERS_KEY).includes(HEADER_TOKEN), false, '再保存即转引用');
});
