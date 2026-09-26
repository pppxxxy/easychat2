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
test('导出会移除 iTXt 里的旧 chara 块，不再携带双份卡数据', () => {
  const exporter = loadExporter();

  const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();
  const crc32 = bytes => bytes.reduce((c, b) => crcTable[(c ^ b) & 0xff] ^ (c >>> 8), 0) >>> 0;
  const makeChunk = (type, data) => {
    const length = new Uint8Array([(data.length >>> 24) & 0xff, (data.length >>> 16) & 0xff, (data.length >>> 8) & 0xff, data.length & 0xff]);
    const typeBytes = Buffer.from(type, 'latin1');
    const body = Buffer.concat([typeBytes, Buffer.from(data)]);
    const crc = new Uint8Array([
      (c => (c >>> 24) & 0xff)(crc32(body)),
      (c => (c >>> 16) & 0xff)(crc32(body)),
      (c => (c >>> 8) & 0xff)(crc32(body)),
      (c => c & 0xff)(crc32(body)),
    ]);
    return new Uint8Array([...length, ...body, ...crc]);
  };
  // iTXt 布局：keyword\0 压缩标志 压缩方法 language\0 translatedKeyword\0 text
  const makeItxt = (keyword, text) => makeChunk('iTXt', Buffer.concat([
    Buffer.from(keyword, 'latin1'), Buffer.from([0, 0, 0, 0, 0]),
    Buffer.from(text, 'utf8'),
  ]));
  const insertAfterIhdr = (png, chunk) => {
    const bytes = Buffer.from(png);
    return new Uint8Array([...bytes.subarray(0, 33), ...chunk, ...bytes.subarray(33)]);
  };
  const itxtKeywords = png => {
    const bytes = Buffer.from(png);
    const found = [];
    let offset = 8;
    while (offset + 8 <= bytes.length) {
      const length = bytes.readUInt32BE(offset);
      const type = bytes.toString('latin1', offset + 4, offset + 8);
      if (type === 'iTXt') {
        const dataEnd = offset + 8 + length;
        let end = offset + 8;
        while (end < dataEnd && bytes[end] !== 0) end += 1;
        found.push(bytes.toString('latin1', offset + 8, end));
      }
      offset += 12 + length;
      if (type === 'IEND') break;
    }
    return found;
  };

  const oldCard = JSON.stringify({ name: '旧角色' });
  const withOldItxt = insertAfterIhdr(
    exporter.createPlaceholderPng(),
    makeItxt('chara', Buffer.from(oldCard).toString('base64'))
  );
  assert.deepEqual(itxtKeywords(withOldItxt), ['chara']);

  const exported = exporter.injectCharaChunk(withOldItxt, JSON.stringify({ name: '新角色' }));
  assert.deepEqual(itxtKeywords(exported), []);
  const parsed = JSON.parse(readJsonFromPNG(exported));
  assert.equal(parsed.name, '新角色');
});
