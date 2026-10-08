// 角色卡分享：端到端（卡 → 分享码 → 二维码 → 解码回卡）+ UI 接线守卫。
//
// 端到端这条是核心：它串起编码器、PNG 落盘、真实解码器与分享码解码，
// 任何一环接错都会在这里暴露——而单看某个模块的测试都是绿的。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const presetEnv = require.resolve('@babel/preset-env');
const jsQR = require('jsqr');
const { unzlibSync } = require('fflate');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = rel => fs.readFileSync(path.join(HERE, '..', rel), 'utf8');

function loadSourceModule(relativePath, stubs = {}) {
  const sourcePath = path.resolve(relativePath);
  const transformed = babel.transformSync(fs.readFileSync(sourcePath, 'utf8'), {
    babelrc: false,
    configFile: false,
    filename: sourcePath,
    presets: [[presetEnv, { targets: { node: 'current' }, modules: 'commonjs' }]],
  }).code;
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (stubs[request]) return stubs[request];
    if (request.endsWith('/i18n/index.js')) return { tActive: key => key };
    if (request.endsWith('/memoryConstants.js')) return { MEMORY_SUMMARY_PREFIX: '记忆总结' };
    if (request.endsWith('/attribution.js')) return { appendExportNotice: s => s, isValidAigcMeta: () => false };
    return originalLoad.call(this, request, parent, isMain);
  };
  const runtime = new Module(sourcePath);
  runtime.filename = sourcePath;
  runtime.paths = Module._nodeModulePaths(path.dirname(sourcePath));
  runtime._compile(transformed, sourcePath);
  Module._load = originalLoad;
  return runtime.exports;
}

function readGrayPng(bytes) {
  const u8 = new Uint8Array(bytes);
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  const read32 = o => ((u8[o] << 24) | (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3]) >>> 0;
  while (offset + 8 <= u8.length) {
    const length = read32(offset);
    const type = String.fromCharCode(u8[offset + 4], u8[offset + 5], u8[offset + 6], u8[offset + 7]);
    if (type === 'IHDR') { width = read32(offset + 8); height = read32(offset + 12); }
    if (type === 'IDAT') idat.push(Buffer.from(u8.slice(offset + 8, offset + 8 + length)));
    offset += 12 + length;
    if (type === 'IEND') break;
  }
  const raw = unzlibSync(new Uint8Array(Buffer.concat(idat)));
  return { width, height, raw };
}

function toImageData(gray) {
  const { width, height, raw } = gray;
  const rowSize = 1 + width;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = raw[y * rowSize + 1 + x];
      const i = (y * width + x) * 4;
      data[i] = value; data[i + 1] = value; data[i + 2] = value; data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

function makeHarness() {
  const written = new Map();
  const fsStub = {
    cacheDirectory: '/tmp/card-share-test/',
    EncodingType: { Base64: 'base64' },
    makeDirectoryAsync: async () => {},
    writeAsStringAsync: async (uri, data, options) => {
      written.set(uri, options && options.encoding === 'base64'
        ? Buffer.from(data, 'base64')
        : Buffer.from(String(data), 'utf8'));
    },
  };
  return {
    written,
    exporter: loadSourceModule('src/character/cardExporter.js', { 'expo-file-system/legacy': fsStub }),
    shareCode: loadSourceModule('src/share/cardShare.js', {}),
  };
}

const SAMPLE_CARD = {
  name: '阿澈',
  description: '银色短发，深蓝色眼睛，旧书店老板。'.repeat(3),
  personality: '话少，习惯用「嗯」回应。',
  scenario: '你是常来书店的客人。',
  firstMes: '「……又是你。」',
  mesExample: '{{user}}：在吗\n阿澈：嗯。',
  creatorNotes: '从对话提炼。',
  tags: ['书店', '冷淡'],
  worldInfo: [{
    id: 'w1', comment: '小镇', keys: ['书店'],
    content: '潮湿的小镇，终年多雨。'.repeat(4), position: 1, enabled: true,
  }],
  regexScripts: [],
  presets: [],
};

test('端到端：角色卡 → 分享码 → 二维码 PNG → 解码 → 得到同一张卡', async () => {
  const { written, exporter, shareCode } = makeHarness();
  const json = exporter.cardToJson(SAMPLE_CARD);
  const code = shareCode.encodeCardShareCode(json);
  assert.equal(shareCode.planShareCode(code).fitsQr, true, '样例卡应装得进二维码');

  const uri = await exporter.exportShareQrFile(code, { scale: 6, quiet: 4 });
  const pngBytes = written.get(uri);
  assert.ok(pngBytes && pngBytes.length > 0, '二维码文件应落盘');

  const gray = readGrayPng(pngBytes);
  const result = jsQR(toImageData(gray).data, gray.width, gray.height);
  assert.ok(result, '二维码必须能被独立解码器扫出');
  assert.equal(result.data, code, '扫出的内容应与分享码完全一致');

  const back = shareCode.decodeCardShareCode(result.data);
  assert.equal(back, json, '还原出的 JSON 应与原卡逐字节一致');
  const parsed = JSON.parse(back);
  assert.equal((parsed.data || parsed).name, '阿澈');
});

test('端到端：分享为图片产出带角色数据的 PNG（对方可直接导入）', async () => {
  const { written, exporter } = makeHarness();
  const uri = await exporter.exportSharePngFile(SAMPLE_CARD, null);
  const bytes = written.get(uri);
  assert.ok(bytes && bytes.length > 0);
  const latin = Buffer.from(bytes).toString('latin1');
  assert.ok(latin.includes('chara'), 'PNG 里应嵌入 chara 数据块');
  // 嵌进去的 base64 解出来应是这张卡
  const marker = latin.indexOf('chara\u0000');
  assert.ok(marker >= 0);
  const base64 = latin.slice(marker + 'chara\u0000'.length).split('\u0000')[0];
  const decoded = JSON.parse(Buffer.from(base64.slice(0, Math.floor(base64.length / 4) * 4), 'base64').toString('utf8'));
  assert.equal((decoded.data || decoded).name, '阿澈');
});

test('端到端：超大卡不生成二维码，但分享码与图片通道仍可用', async () => {
  const { exporter, shareCode } = makeHarness();
  const huge = {
    ...SAMPLE_CARD,
    worldInfo: Array.from({ length: 60 }, (unused, index) => ({
      id: `w${index}`, comment: `设定${index}`, keys: ['小镇'],
      content: `第 ${index} 条很长的世界书内容，描述小镇的气候、人物与历史。`.repeat(6),
      position: 1, enabled: true,
    })),
  };
  const code = shareCode.encodeCardShareCode(exporter.cardToJson(huge));
  const plan = shareCode.planShareCode(code);
  assert.equal(plan.fitsQr, false, '超大卡应被判定为装不进二维码');
  assert.ok(plan.overBy > 0, '应给出超出量供界面提示');
  // 分享码本身仍然完整可用（这是超大卡唯一的文本通道）
  assert.equal(shareCode.decodeCardShareCode(code), exporter.cardToJson(huge));
});

test('UI 接线：详情页有分享入口与剪贴板导入，且都走域内封装', () => {
  const detail = read('src/character/CharacterDetailScreen.js');
  const modal = read('src/character/CardShareModal.js');
  const exporter = read('src/character/cardExporter.js');

  assert.ok(detail.includes("import CardShareModal from './CardShareModal.js';"));
  assert.ok(detail.includes('onPress={onShare}'), '分享入口按钮');
  assert.ok(detail.includes("t('character.share.entry')"));
  assert.ok(detail.includes('<CardShareModal'), '渲染分享面板');
  assert.ok(detail.includes('onPress={importFromClipboard}'), '剪贴板导入入口');
  assert.ok(detail.includes('isCardShareCode(text)'), '导入前先校验是不是分享码');

  // 文件写入必须在 cardExporter（域内封装点），UI 不得直接碰 expo-file-system
  assert.ok(!modal.includes("expo-file-system"), 'UI 不得直接 import 文件系统（lint 也会拦）');
  assert.ok(exporter.includes('export async function exportShareQrFile'));
  assert.ok(exporter.includes('export async function exportSharePngFile'));
  assert.ok(modal.includes('exportShareQrFile('));
  assert.ok(modal.includes('exportSharePngFile('));
});

test('UI 接线：二维码/容量两分支都渲染，且不假装有扫码器', () => {
  const modal = read('src/character/CardShareModal.js');
  assert.ok(modal.includes('plan.fitsQr ?'), '容量够与不够是两个分支');
  assert.ok(modal.includes("t('character.share.tooLarge.title')"), '装不下时如实说明');
  assert.ok(modal.includes("t('character.share.copy')"), '任何情况都给复制分享码');
  assert.ok(modal.includes("t('character.share.sharePng')"), '任何情况都给分享图片');
  // 诚实性：文案必须告知「需先用系统相机/扫码工具读出文本」
  const zh = read('src/i18n/locales/zh-CN/character.js');
  assert.ok(zh.includes('本应用暂未内置扫码器'), '不得暗示应用内可直接扫码');
});

test('分享词条中英齐备', () => {
  const zh = read('src/i18n/locales/zh-CN/character.js');
  const en = read('src/i18n/locales/en/character.js');
  const keys = [
    'character.share.entry',
    'character.share.title',
    'character.share.meta',
    'character.share.qrTitle',
    'character.share.qrHint',
    'character.share.tooLarge.title',
    'character.share.tooLarge.body',
    'character.share.copy',
    'character.share.sharePng',
    'character.share.pasteImport',
    'character.share.pasteInvalid.title',
    'character.share.pasteEmpty.title',
  ];
  keys.forEach(key => {
    assert.ok(zh.includes(`'${key}'`), `zh-CN 缺 ${key}`);
    assert.ok(en.includes(`'${key}'`), `en 缺 ${key}`);
  });
});
