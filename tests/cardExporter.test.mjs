import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { readJsonFromPNG, writeJsonToPNG } from 'parsecard';

import { parseCardFromJson } from '../src/cardParser.js';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const presetEnv = require.resolve('@babel/preset-env');
const sourcePath = path.resolve('src/cardExporter.js');
const transformed = babel.transformSync(fs.readFileSync(sourcePath, 'utf8'), {
  babelrc: false,
  configFile: false,
  filename: sourcePath,
  presets: [[presetEnv, { targets: { node: 'current' }, modules: 'commonjs' }]],
}).code;

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'expo-file-system') return {};
  return originalLoad.call(this, request, parent, isMain);
};

function loadExporter() {
  const filename = path.resolve('src/cardExporter.test-runtime.cjs');
  const runtimeModule = new Module(filename);
  runtimeModule.filename = filename;
  runtimeModule.paths = Module._nodeModulePaths(path.dirname(filename));
  runtimeModule._compile(transformed, filename);
  return runtimeModule.exports;
}

test('导出会移除原图里的旧 ccv3/chara chunk，重新导入得到新数据', () => {
  const exporter = loadExporter();
  const avatar = exporter.createPlaceholderPng();
  const oldJson = JSON.stringify({ name: '旧角色' });
  const withOldCard = writeJsonToPNG(avatar, oldJson, {
    writeChara: false,
    writeCcv3: true,
    ccv3JsonString: oldJson,
  });
  const exported = exporter.injectCharaChunk(withOldCard, JSON.stringify({ name: '新角色' }));
  const parsed = JSON.parse(readJsonFromPNG(exported));
  assert.equal(parsed.name, '新角色');
});

test('世界书导出保留 role、depth、probability、scan_depth 并可重新解析', () => {
  const exporter = loadExporter();
  const json = exporter.cardToJson({
    name: '角色',
    worldInfo: [{
      id: 'w1',
      comment: '条目',
      keys: ['关键词'],
      secondaryKeys: [],
      content: '设定',
      role: 'assistant',
      depth: 7,
      probability: 35,
      scanDepth: 9,
    }],
  });
  const parsed = parseCardFromJson(json);
  const entry = parsed.worldInfo[0];
  assert.equal(entry.role, 'assistant');
  assert.equal(entry.depth, 7);
  assert.equal(entry.probability, 35);
  assert.equal(entry.scanDepth, 9);
});