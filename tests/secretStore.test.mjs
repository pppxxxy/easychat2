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

// 诊断留痕是本次修复的一半（「静默」正是缺陷的本质），所以这里把 diagnostics 换成
// 可断言的桩：真模块在纯 Node 下没有 AsyncStorage，读不回/置空这两条异常若只走内存
// 缓存，测试就断言不到「有没有留痕」。
const diagnostics = [];
const diagnosticsMock = {
  recordDiagnostic: (kind, error, context = '') => {
    diagnostics.push({
      kind,
      message: error && error.message !== undefined ? String(error.message) : String(error),
      context: String(context),
    });
  },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'expo-secure-store') return secureMock;
  if (request === './diagnostics.js' || request.endsWith('/diagnostics.js')) return diagnosticsMock;
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
  readSecureValue,
  SECRET_UNAVAILABLE_KEY,
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

// ---- 读侧两条不可逆缺陷（逐行审查：密钥层）----
// ① 引用还在、值读不回：旧实现静默回填空串 ⇒ UI 空框 ⇒ 用户随手保存 ⇒ 明文 '' 覆盖盘上引用
//    ⇒ SecureStore 里的旧记录成永久孤儿，密钥不可逆丢失且诊断零记录。
// ② SecureStore 整体不可用：旧实现原样返回 ⇒ `secure:v1:...` 被当凭据拼进
//    `Authorization: Bearer ...` 发给服务商。

test('🔴 引用读不回：保留原引用串（绝不回填空串）+ 留痕 + 打标记', async () => {
  __resetSecretStoreForTests();
  secureValues.clear();
  diagnostics.length = 0;
  const ref = 'secure:v1:missing_id';
  const hydrated = await hydrateSecrets('@easychat2_api_configs', {
    configs: [{ id: 'a', apiKey: ref }],
  });
  // 关键断言：**不是** ''。空串会让用户看到空框并随手保存，把盘上的引用覆盖掉。
  assert.equal(hydrated.configs[0].apiKey, ref, '读不回必须保留原引用串，不得回填空串');
  assert.notEqual(hydrated.configs[0].apiKey, '');
  // 标记必须冒泡到最外层：调用方拿到的是整份 payload，不会去遍历深层节点。
  assert.equal(hydrated[SECRET_UNAVAILABLE_KEY], true, '顶层必须带 SECRET_UNAVAILABLE_KEY 标记');
  // 必须留痕（旧实现零记录）。
  assert.ok(
    diagnostics.some(item => item.kind === 'secrets' && item.message.includes('无法还原')),
    '读不回必须记一条 secrets 诊断'
  );
  assert.ok(
    diagnostics.some(item => item.context.includes('@easychat2_api_configs')),
    '诊断 context 必须带命名空间，便于定位是哪份配置'
  );
});

test('🔴 读不回与「确实存了空串」必须可区分：空串是成功、不记诊断', async () => {
  __resetSecretStoreForTests();
  secureValues.clear();
  diagnostics.length = 0;
  // 这条记录**确实**是空串（写入侧允许写入空串），读回成功 ⇒ 不是异常，不该刷诊断。
  secureValues.set('easychat2_secret_@easychat2_api_configs_configs_a_apiKey', '');
  const hydrated = await hydrateSecrets('@easychat2_api_configs', {
    configs: [{ id: 'a', apiKey: 'secure:v1:@easychat2_api_configs_configs_a_apiKey' }],
  });
  assert.equal(hydrated.configs[0].apiKey, '');
  assert.equal(hydrated[SECRET_UNAVAILABLE_KEY], undefined, '成功读回不该打「不可用」标记');
  assert.deepEqual(diagnostics, [], '确实存了空串是成功路径，不该记诊断');
});

test('🔴 readSecureValue 对外仍返回字符串（旧契约，单角色锁密码依赖）', async () => {
  __resetSecretStoreForTests();
  secureValues.clear();
  assert.equal(await readSecureValue('missing_lock_pin'), '', '读不回时对外仍是空串而非 null');
  await mod.writeSecureValue('some_lock_pin', '1234');
  assert.equal(await readSecureValue('some_lock_pin'), '1234');
});

test('🔴 安全存储不可用时：置空引用字段 + 标记 + 留痕，绝不把引用串交给调用方', async () => {
  __resetSecretStoreForTests();
  secureValues.clear();
  diagnostics.length = 0;
  const originalGet = secureMock.getItemAsync;
  const originalSet = secureMock.setItemAsync;
  // 模拟原生模块 require 失败：isSecretStoreAvailable() 为假。
  delete secureMock.getItemAsync;
  delete secureMock.setItemAsync;
  try {
    const hydrated = await hydrateSecrets('@easychat2_api_configs', {
      configs: [{ id: 'a', apiKey: 'secure:v1:apiConfigs_0_apiKey', baseUrl: 'https://a/v1' }],
    });
    // 核心断言：引用串**绝不能**流到调用方（网络层没有任何引用串守卫）。
    assert.equal(hydrated.configs[0].apiKey, '', '不可用时必须置空，不得泄漏内部引用串');
    assert.equal(
      JSON.stringify(hydrated).includes('secure:v1:'),
      false,
      '整份 payload 序列化后不得残留引用串（它会被拼进 Authorization 头）'
    );
    // 非密钥字段不受影响（置空只针对引用串，不能顺手清掉用户配置）。
    assert.equal(hydrated.configs[0].baseUrl, 'https://a/v1');
    // 与 ① 共用同一个标记与同一条诊断口径。
    assert.equal(hydrated[SECRET_UNAVAILABLE_KEY], true);
    assert.ok(
      diagnostics.some(item => item.kind === 'secrets' && item.message.includes('无法还原')),
      '不可用时必须留痕（旧实现零记录）'
    );
  } finally {
    secureMock.getItemAsync = originalGet;
    secureMock.setItemAsync = originalSet;
    __resetSecretStoreForTests();
  }
});

test('🔴 写侧仍保持「不可用就原样返回」的有意降级（不丢密钥）', async () => {
  __resetSecretStoreForTests();
  secureValues.clear();
  const originalGet = secureMock.getItemAsync;
  const originalSet = secureMock.setItemAsync;
  delete secureMock.getItemAsync;
  delete secureMock.setItemAsync;
  try {
    const payload = { configs: [{ id: 'a', apiKey: 'sk-plain-keep' }] };
    const protectedPayload = await protectSecrets('@easychat2_api_configs', payload);
    // 写侧与读侧语义相反：写侧怕丢数据（保持明文），读侧怕泄漏凭据（置空）。
    assert.equal(protectedPayload.configs[0].apiKey, 'sk-plain-keep');
  } finally {
    secureMock.getItemAsync = originalGet;
    secureMock.setItemAsync = originalSet;
    __resetSecretStoreForTests();
  }
});

test('🔴 请求头读不回时同样保留引用串 + 打标记（与标量分支同一口径）', async () => {
  __resetSecretStoreForTests();
  secureValues.clear();
  diagnostics.length = 0;
  const ref = 'secure:v1:missing_header_id';
  const hydrated = await hydrateSecrets('@easychat2_mcp_servers', [{
    id: 'notes',
    headers: { Authorization: ref, 'X-Ok': 'plain-value' },
  }]);
  // 既有纪律不变：读不回的头**不还原**（不把引用串当真头发出去）。
  assert.deepEqual(hydrated[0].headers, { 'X-Ok': 'plain-value' });
  assert.equal(JSON.stringify(hydrated[0].headers).includes('secure:v1:'), false);
  // 新增：对象字段的读不回也要能冒泡到顶层，否则 UI 无从提示。
  assert.equal(hydrated[SECRET_UNAVAILABLE_KEY], true);
  assert.ok(diagnostics.some(item => item.kind === 'secrets'));
});

test('🔴 读不回不写入缓存：安全存储恢复后同一次运行内可自愈', async () => {
  __resetSecretStoreForTests();
  secureValues.clear();
  const ns = '@easychat2_api_configs';
  const ref = 'secure:v1:@easychat2_api_configs_configs_a_apiKey';
  // 先读一次（记录不存在 ⇒ 读不回）。
  const first = await hydrateSecrets(ns, { configs: [{ id: 'a', apiKey: ref }] });
  assert.equal(first.configs[0].apiKey, ref);
  // 之后记录变得可读（Keystore 恢复 / 记录被重新写入）。
  secureValues.set('easychat2_secret_@easychat2_api_configs_configs_a_apiKey', 'sk-recovered');
  const second = await hydrateSecrets(ns, { configs: [{ id: 'a', apiKey: ref }] });
  assert.equal(
    second.configs[0].apiKey,
    'sk-recovered',
    '读不回不得进缓存（缓存异常态等于把异常固化成常态，先例 diagnostics.js:40-58）'
  );
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
