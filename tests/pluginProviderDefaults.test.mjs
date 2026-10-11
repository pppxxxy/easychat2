// 联网搜索插件配置的归一化：默认提供方 + 在售提供方白名单。
//
// 两个风险点：
//   1) PLUGIN_PROVIDERS 是「已下架提供方」的判定依据，漏登记某个在售 id 会让
//      存量配置被判为迁移、静默换源并弹一次性提示；
//   2) 默认 provider 决定新装用户开箱能不能直接搜——AnySearch 匿名档无需密钥，
//      所以它必须是默认值。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const presetEnv = require.resolve('@babel/preset-env');

const PLUGINS_KEY = '@easychat2_plugins';
const store = new Map();

const ioStub = {
  readJsonStatusWithSecrets: async key => {
    if (!store.has(key)) return { status: 'missing' };
    try {
      return { status: 'ok', value: JSON.parse(store.get(key)) };
    } catch (error) {
      return { status: 'corrupt' };
    }
  },
  setJsonWithSecrets: async (key, payload) => {
    store.set(key, JSON.stringify(payload));
    return payload;
  },
  backupCorruptValue: async () => {},
};

const sourcePath = path.resolve('src/storage/settings/plugins.js');
const transformed = babel.transformSync(fs.readFileSync(sourcePath, 'utf8'), {
  babelrc: false,
  configFile: false,
  filename: sourcePath,
  presets: [[presetEnv, { targets: { node: 'current' }, modules: 'commonjs' }]],
}).code;
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request.endsWith('/io.js')) return ioStub;
  if (request.endsWith('/i18n/index.js')) return { tActive: key => key };
  return originalLoad.call(this, request, parent, isMain);
};
const runtime = new Module(sourcePath);
runtime.filename = sourcePath;
runtime.paths = Module._nodeModulePaths(path.dirname(sourcePath));
runtime._compile(transformed, sourcePath);
Module._load = originalLoad;

const { getPlugins } = runtime.exports;

const webSearchOf = list => (Array.isArray(list) ? list : []).find(item => item.id === 'web-search');

test('默认提供方：AnySearch 匿名档（无需密钥即可搜）', async () => {
  store.clear();
  const plugin = webSearchOf(await getPlugins());
  assert.ok(plugin, '内置联网搜索插件存在');
  assert.equal(plugin.config.provider, 'anysearch');
  assert.equal(plugin.enabled, false, '默认不开启，联网外发要用户显式同意');
});

test('在售提供方白名单：anysearch 与 anysearch-key 都不被判为迁移换源', async () => {
  for (const provider of ['anysearch', 'anysearch-key']) {
    store.clear();
    store.set(PLUGINS_KEY, JSON.stringify([
      { id: 'web-search', type: 'web-search', enabled: true, config: { provider, apiKey: 'k' } },
    ]));
    const plugin = webSearchOf(await getPlugins());
    assert.equal(plugin.config.provider, provider, `${provider} 应原样保留`);
    assert.equal(plugin.config.providerMigrated, undefined, `${provider} 不应带迁移标记`);
  }
});

test('已下架提供方（bing）回退到默认匿名档并留迁移标记', async () => {
  store.clear();
  store.set(PLUGINS_KEY, JSON.stringify([
    { id: 'web-search', type: 'web-search', enabled: true, config: { provider: 'bing', apiKey: 'k' } },
  ]));
  const plugin = webSearchOf(await getPlugins());
  assert.equal(plugin.config.provider, 'anysearch');
  assert.equal(plugin.config.providerMigrated, 'bing');
});
