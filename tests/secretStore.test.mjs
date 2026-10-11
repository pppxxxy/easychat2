import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { maskSecrets } from '../src/storage/secrets.js';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const sourcePath = path.resolve('src/storage/secretStore.js');
const transformed = babel.transformSync(fs.readFileSync(sourcePath, 'utf8'), {
  babelrc: false,
  configFile: false,
  filename: sourcePath,
  presets: [[require.resolve('@babel/preset-env'), { targets: { node: 'current' }, modules: 'commonjs' }]],
}).code;

const secureValues = new Map();
let available = true;
const secureMock = {
  setItemAsync: async (key, value) => {
    if (!available) throw new Error('unavailable');
    secureValues.set(key, value);
  },
  getItemAsync: async key => (secureValues.has(key) ? secureValues.get(key) : null),
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'expo-secure-store') return secureMock;
  return originalLoad.call(this, request, parent, isMain);
};

function loadModule() {
  const filename = path.resolve('src/storage/secretStore.js');
  const runtimeModule = new Module(filename);
  runtimeModule.filename = filename;
  runtimeModule.paths = Module._nodeModulePaths(path.dirname(filename));
  runtimeModule._compile(transformed, filename);
  return runtimeModule.exports;
}

const mod = loadModule();
const {
  isSecretRef,
  protectSecrets,
  hydrateSecrets,
  __resetSecretStoreForTests,
} = mod;

test('写盘前把密钥抽到安全存储并落引用，读回能还原明文', async () => {
  __resetSecretStoreForTests();
  secureValues.clear();
  const payload = {
    configs: [
      { id: 'a', baseUrl: 'https://a/v1', apiKey: 'sk-secret-a' },
      { id: 'b', baseUrl: 'https://b/v1', apiKey: 'sk-secret-b' },
    ],
    activeId: 'a',
  };
  const protectedPayload = await protectSecrets('@easychat2_api_configs', payload);
  // 落盘的 payload 里不能出现明文
  const serialized = JSON.stringify(protectedPayload);
  assert.equal(serialized.includes('sk-secret-a'), false);
  assert.equal(serialized.includes('sk-secret-b'), false);
  assert.ok(isSecretRef(protectedPayload.configs[0].apiKey));
  // 安全存储里保存了明文
  assert.deepEqual([...secureValues.values()].sort(), ['sk-secret-a', 'sk-secret-b']);
  // 读回还原
  const hydrated = await hydrateSecrets('@easychat2_api_configs', protectedPayload);
  assert.equal(hydrated.configs[0].apiKey, 'sk-secret-a');
  assert.equal(hydrated.configs[1].apiKey, 'sk-secret-b');
});

test('存储边界登记的密钥可被脱敏（脱敏双保险）', async () => {
  __resetSecretStoreForTests();
  secureValues.clear();
  // 不使用 sk-/Bearer 等可识别前缀的无格式随机串，正则兜不住，只能靠登记表
  const plain = 'zQ7plaincustomsecretvalue9x';
  const protectedPayload = await protectSecrets('@easychat2_api_configs', {
    configs: [{ id: 'a', apiKey: plain }],
  });
  assert.equal(maskSecrets(`接口失败: ${plain}`).includes(plain), false);
  const hydrated = await hydrateSecrets('@easychat2_api_configs', protectedPayload);
  assert.equal(hydrated.configs[0].apiKey, plain);
});

test('确定性 id：同一字段重复保存覆盖同一条，不产生孤儿密钥', async () => {
  __resetSecretStoreForTests();
  secureValues.clear();
  const ns = '@easychat2_api_configs';
  const first = await protectSecrets(ns, { configs: [{ id: 'a', apiKey: 'sk-1' }] });
  const ref1 = first.configs[0].apiKey;
  const second = await protectSecrets(ns, { configs: [{ id: 'a', apiKey: 'sk-2' }] });
  const ref2 = second.configs[0].apiKey;
  assert.equal(ref1, ref2);
  assert.equal(secureValues.size, 1);
  const hydrated = await hydrateSecrets(ns, second);
  assert.equal(hydrated.configs[0].apiKey, 'sk-2');
});

test('数组顺序变化后密钥仍指向自条目 id', async () => {
  __resetSecretStoreForTests();
  secureValues.clear();
  const ns = '@easychat2_api_configs';
  const protectedA = await protectSecrets(ns, { configs: [{ id: 'a', apiKey: 'sk-a' }, { id: 'b', apiKey: 'sk-b' }] });
  // 交换顺序后重新保护：引用不变，读回仍对应各自明文
  const reordered = await protectSecrets(ns, {
    configs: [protectedA.configs[1], protectedA.configs[0]],
  });
  const hydrated = await hydrateSecrets(ns, reordered);
  assert.equal(hydrated.configs[0].apiKey, 'sk-b');
  assert.equal(hydrated.configs[1].apiKey, 'sk-a');
});

test('旧明文数据读取原样返回，下次保存自动转引用', async () => {
  __resetSecretStoreForTests();
  secureValues.clear();
  const ns = '@easychat2_image_gen';
  const legacy = { providers: { openai: { apiKey: 'sk-legacy' } } };
  const hydrated = await hydrateSecrets(ns, legacy);
  assert.equal(hydrated.providers.openai.apiKey, 'sk-legacy');
  const protectedPayload = await protectSecrets(ns, legacy);
  assert.ok(isSecretRef(protectedPayload.providers.openai.apiKey));
});

test('字段白名单：apiKeyUrl 等非密钥字段不受影响', async () => {
  __resetSecretStoreForTests();
  secureValues.clear();
  const payload = await protectSecrets('@easychat2_api_configs', {
    configs: [{ id: 'a', apiKey: 'sk-1', apiKeyUrl: 'https://example.com/key' }],
  });
  assert.equal(payload.configs[0].apiKeyUrl, 'https://example.com/key');
  assert.ok(isSecretRef(payload.configs[0].apiKey));
});

test('安全存储写入失败时透明降级为明文（不丢密钥、不阻断保存）', async () => {
  __resetSecretStoreForTests();
  secureValues.clear();
  available = true;
  const originalSet = secureMock.setItemAsync;
  secureMock.setItemAsync = async () => { throw new Error('write failed'); };
  try {
    const payload = { configs: [{ id: 'a', apiKey: 'sk-plain' }] };
    const protectedPayload = await protectSecrets('@easychat2_api_configs', payload);
    // 写入失败 → 保持明文而非丢失
    assert.equal(protectedPayload.configs[0].apiKey, 'sk-plain');
    assert.equal(isSecretRef(protectedPayload.configs[0].apiKey), false);
  } finally {
    secureMock.setItemAsync = originalSet;
  }
});

test('读取引用但安全存储无值时回填空串（不抛错）', async () => {
  __resetSecretStoreForTests();
  secureValues.clear();
  const hydrated = await hydrateSecrets('@easychat2_api_configs', {
    configs: [{ id: 'a', apiKey: 'secure:v1:missing_id' }],
  });
  assert.equal(hydrated.configs[0].apiKey, '');
});

// ---- 对象字段（MCP 自定义请求头）----
// 回归 2026-10-11 逐行审查：headers 是 UI 明确让用户填的（提示就是 `Authorization: Bearer <token>`），
// 却不在 SECRET_FIELDS 里——token 明文写进 AsyncStorage。这里钉住「逐个值走保险箱」。

test('对象字段：请求头逐个值走保险箱，盘上不留明文、键名留在盘上', async () => {
  __resetSecretStoreForTests();
  secureValues.clear();
  const ns = '@easychat2_mcp_servers';
  const token = 'zQ7plaincustomheadersecret9x'; // 无 sk-/Bearer 前缀，正则兜不住，只能靠登记表
  const protectedPayload = await protectSecrets(ns, [{
    id: 'notes',
    mcpToken: 'zQ7mcptokenplain9x',
    headers: { Authorization: `Bearer ${token}`, 'X-Api-Key': token },
  }]);
  const serialized = JSON.stringify(protectedPayload);
  assert.equal(serialized.includes(token), false, '盘上不得出现请求头明文');
  assert.equal(serialized.includes('zQ7mcptokenplain9x'), false, 'mcpToken 同样不得明文');
  // 键名留在盘上：排查「配了哪些头」不需要密钥，值一个都不能留。
  assert.deepEqual(Object.keys(protectedPayload[0].headers).sort(), ['Authorization', 'X-Api-Key']);
  assert.ok(isSecretRef(protectedPayload[0].headers.Authorization));
  assert.ok(isSecretRef(protectedPayload[0].headers['X-Api-Key']));
  // **逐个值**各一条记录：整对象 JSON 化会撞 expo-secure-store 的 2048 字节单值上限
  //（每个头的值单独看远小于上限）。
  assert.deepEqual(
    [...secureValues.values()].sort(),
    ['Bearer zQ7plaincustomheadersecret9x', 'zQ7mcptokenplain9x', token].sort()
  );
  // 读回：headers 完整还原
  const hydrated = await hydrateSecrets(ns, protectedPayload);
  assert.deepEqual(hydrated[0].headers, { Authorization: `Bearer ${token}`, 'X-Api-Key': token });
  assert.equal(hydrated[0].mcpToken, 'zQ7mcptokenplain9x');
});

test('对象字段按域键限定：别的域的同名 headers 不动（不误搬进安全存储）', async () => {
  __resetSecretStoreForTests();
  secureValues.clear();
  const payload = await protectSecrets('@easychat2_web_search', {
    headers: { Authorization: 'Bearer other-domain-value' },
  });
  assert.equal(payload.headers.Authorization, 'Bearer other-domain-value');
  assert.equal(isSecretRef(payload.headers.Authorization), false);
  assert.equal(secureValues.size, 0);
});

test('请求头引用读不回时不还原（宁可少一个头，也不把引用串当真头发出去）', async () => {
  __resetSecretStoreForTests();
  secureValues.clear();
  const hydrated = await hydrateSecrets('@easychat2_mcp_servers', [{
    id: 'notes',
    headers: { Authorization: 'secure:v1:missing_header_id', 'X-Ok': 'plain-value' },
  }]);
  assert.deepEqual(hydrated[0].headers, { 'X-Ok': 'plain-value' });
});

test('legacy 明文请求头原样读回 + 登记脱敏，下次保存自动转引用', async () => {
  __resetSecretStoreForTests();
  secureValues.clear();
  const plain = 'zQ7legacyheaderplainsecret9x';
  const hydrated = await hydrateSecrets('@easychat2_mcp_servers', [
    { id: 'notes', headers: { Authorization: plain } },
  ]);
  assert.equal(hydrated[0].headers.Authorization, plain);
  assert.equal(maskSecrets(`连不上: ${plain}`).includes(plain), false, '旧数据的头值也必须脱敏');
  const protectedPayload = await protectSecrets('@easychat2_mcp_servers', hydrated);
  assert.ok(isSecretRef(protectedPayload[0].headers.Authorization));
});

test('对象字段重复保存覆盖同一条记录，不产生孤儿密钥', async () => {
  __resetSecretStoreForTests();
  secureValues.clear();
  const ns = '@easychat2_mcp_servers';
  const first = await protectSecrets(ns, [{ id: 'notes', headers: { Authorization: 'Bearer one' } }]);
  const second = await protectSecrets(ns, [{ id: 'notes', headers: { Authorization: 'Bearer two' } }]);
  assert.equal(first[0].headers.Authorization, second[0].headers.Authorization);
  assert.equal(secureValues.size, 1);
  const hydrated = await hydrateSecrets(ns, second);
  assert.equal(hydrated[0].headers.Authorization, 'Bearer two');
});
