import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { readJsonFromPNG, WorldBookEntry, writeJsonToPNG } from 'parsecard';

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

test('导出体积超过应用导入上限时明确拒绝', () => {
  const exporter = loadExporter();
  exporter.assertCardFileSize(exporter.MAX_CARD_FILE_BYTES, 'json');
  assert.throws(
    () => exporter.assertCardFileSize(exporter.MAX_CARD_FILE_BYTES + 1, 'png'),
    /超过应用/
  );
});

test('PNG 导出时非 PNG 头像不再静默替换为占位图', () => {
  const exporter = loadExporter();
  assert.throws(
    () => exporter.cardToPng({ name: '角色' }, Uint8Array.from([1, 2, 3])),
    /头像不是合法的 PNG/
  );
  assert.ok(exporter.cardToPng({ name: '角色' }, null).length > 0);
});

test('导出会写回第三方扩展与顶层透传字段', () => {
  const exporter = loadExporter();
  const card = exporter.buildCardV2({
    name: '作者卡',
    regexScripts: [],
    presets: [],
    cardExtensions: { talkativeness: 0.8, fav: true },
    cardExtra: { creator: '某作者', character_version: '3.1' },
  });
  assert.equal(card.data.extensions.talkativeness, 0.8);
  assert.equal(card.data.extensions.fav, true);
  assert.equal(card.data.creator, '某作者');
  assert.equal(card.data.character_version, '3.1');
  assert.equal(card.data.name, '作者卡');
});

test('空原始 systemPrompt 导出时不被组合提示覆盖', () => {
  const exporter = loadExporter();
  const raw = JSON.parse(exporter.cardToJson({
    name: '角色',
    systemPrompt: '',
    systemPromptComposed: '派生提示',
  }));
  assert.equal(raw.data.system_prompt, '');
});

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
      matchWholeWords: true,
      useProbability: false,
      boundary: 'message-boundary',
    }],
  });
  const parsed = parseCardFromJson(json);
  const entry = parsed.worldInfo[0];
  assert.equal(entry.role, 'assistant');
  assert.equal(entry.depth, 7);
  assert.equal(entry.probability, 35);
  assert.equal(entry.scanDepth, 9);
  assert.equal(entry.matchWholeWords, true);
   assert.equal(entry.useProbability, false);
   assert.equal(entry.boundary, 'message-boundary');

  const raw = JSON.parse(json);
  const external = WorldBookEntry.fromEmbeddedJSON(raw.data.character_book.entries[0]);
  assert.equal(external.role, 2);
  assert.equal(external.matchWholeWords, true);
  assert.equal(external.useProbability, false);
});