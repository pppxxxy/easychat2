// 看屏幕「画面识别来源」（src/screenWatch/frameRecognition.js）：行为测试。
//
// 为什么必须有：需求要求「看屏幕走主模型还是走 OCR 模型」这个选择**真的生效**，
// 而 useScreenWatchComments 是 React hook、Node 里跑不动。判定与请求形态抽到
// frameRecognition 的纯函数后，才能用真实模块 + 打桩依赖把它钉住。
//
// 覆盖的关键判定（改回错写法就会变红）：
// - source='main'：画面原样交给主模型，**不调用 OCR**（既有行为不变）；
// - source='ocr'：先识别，请求里放描述文本；主模型能看图且开了「附原图」时才带图；
// - source='ocr' + 识别失败 + 主模型能看图 → 退回直发原图（不静默丢画面）；
// - source='ocr' + 识别失败 + 主模型看不到图 → error='ocr-failed'（用户可见的失败）；
// - source='ocr' + 识别未就绪 → error='ocr-unavailable'；
// - 描述文本拼进用户文本（原有内容不被覆盖）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const presetEnv = require.resolve('@babel/preset-env');

let describeCalls = 0;
let lastDescribeOptions = null;
let describeResult = null;
const engineStub = {
  describeImages: async (uris, options) => {
    describeCalls += 1;
    lastDescribeOptions = { uris, options };
    return describeResult;
  },
};

let storedSource = 'main';
const settingsStub = {
  getImageRecognitionSettings: async () => ({ screenWatchSource: storedSource }),
};

const stubs = {
  [path.resolve('src/imageRecognition/index.js')]: engineStub,
  [path.resolve('src/storage/settings/imageRecognition.js')]: settingsStub,
};
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  if (typeof request === 'string' && request.startsWith('.') && parent && parent.filename) {
    const resolved = path.resolve(path.dirname(parent.filename), request);
    if (Object.prototype.hasOwnProperty.call(stubs, resolved)) return stubs[resolved];
  }
  return originalLoad.call(this, request, parent, isMain);
};

function loadModule(sourcePath) {
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
  return runtime.exports;
}

const {
  buildScreenWatchRequestShape,
  mergeDescriptionIntoUserText,
  resolveScreenWatchRequest,
  resolveScreenWatchSource,
} = loadModule(path.resolve('src/screenWatch/frameRecognition.js'));

const URIS = ['data:image/jpeg;base64,AAA', 'data:image/jpeg;base64,BBB'];

function recognition(overrides = {}) {
  return {
    text: '【图片内容（由图片识别模型转述）】\n画面里是一个设置页',
    descriptions: [],
    failureCount: 0,
    skipped: false,
    reason: '',
    attachOriginal: false,
    ...overrides,
  };
}

test('source=main：画面原样交给主模型，不调用 OCR（既有行为不变）', async () => {
  describeCalls = 0;
  const shape = buildScreenWatchRequestShape({ source: 'main', dataUris: URIS, mainModelVision: true });
  assert.deepEqual(shape.images, URIS);
  assert.equal(shape.descriptionText, '');
  assert.equal(shape.useDescriptionOnly, false);
  assert.equal(shape.error, '');

  const viaOrchestrator = await resolveScreenWatchRequest({ source: 'main', dataUris: URIS });
  assert.deepEqual(viaOrchestrator.images, URIS);
  assert.equal(describeCalls, 0, '主模型直接看时不该发起 OCR 请求');
});

test('source=ocr：先识别，请求里放描述文本，默认不附原图', async () => {
  describeCalls = 0;
  describeResult = recognition({ attachOriginal: false });
  const shape = await resolveScreenWatchRequest({
    source: 'ocr',
    dataUris: URIS,
    mainModelVision: false,
  });
  assert.equal(describeCalls, 1, '必须真的走一次图片识别');
  assert.deepEqual(shape.images, [], '主模型看不到图时不附原图');
  assert.ok(shape.descriptionText.includes('画面里是一个设置页'), '描述文本要进请求');
  assert.equal(shape.useDescriptionOnly, true);
  assert.equal(shape.error, '');
  assert.deepEqual(lastDescribeOptions.uris, URIS);
});

test('source=ocr + 主模型能看图且开了附原图：描述与原图同时带上', async () => {
  describeCalls = 0;
  describeResult = recognition({ attachOriginal: true });
  const shape = await resolveScreenWatchRequest({ source: 'ocr', dataUris: URIS, mainModelVision: true });
  assert.deepEqual(shape.images, URIS, '开了附原图就要带上');
  assert.ok(shape.descriptionText.length > 0, '描述照发');
  assert.equal(shape.useDescriptionOnly, false);
});

test('source=ocr + 识别失败 + 主模型能看图 → 退回直发原图（不静默丢画面）', () => {
  const shape = buildScreenWatchRequestShape({
    source: 'ocr',
    dataUris: URIS,
    recognition: recognition({ failureCount: 1, text: '' }),
    mainModelVision: true,
  });
  assert.deepEqual(shape.images, URIS, '退回直发原图');
  assert.equal(shape.error, '', '有兜底就不算失败');
});

test('source=ocr + 识别失败 + 主模型看不到图 → ocr-failed（用户可见的失败）', () => {
  const shape = buildScreenWatchRequestShape({
    source: 'ocr',
    dataUris: URIS,
    recognition: recognition({ failureCount: 1, text: '' }),
    mainModelVision: false,
  });
  assert.equal(shape.error, 'ocr-failed');
  assert.deepEqual(shape.images, [], '不能假装有内容可发');
});

test('source=ocr + 识别未就绪（skipped）→ ocr-unavailable', () => {
  const shape = buildScreenWatchRequestShape({
    source: 'ocr',
    dataUris: URIS,
    recognition: recognition({ skipped: true, reason: 'no-model', text: '' }),
    mainModelVision: false,
  });
  assert.equal(shape.error, 'ocr-unavailable');
  // 主模型能看图时也一样：用户选了 OCR 但没配好，应该明确提示而不是悄悄换路径
  const withVision = buildScreenWatchRequestShape({
    source: 'ocr',
    dataUris: URIS,
    recognition: recognition({ skipped: true, reason: 'disabled', text: '' }),
    mainModelVision: true,
  });
  assert.equal(withVision.error, 'ocr-unavailable');
});

test('source=ocr 但没传识别结果 → ocr-unavailable（不能当成识别成功）', () => {
  const shape = buildScreenWatchRequestShape({ source: 'ocr', dataUris: URIS, mainModelVision: true });
  assert.equal(shape.error, 'ocr-unavailable');
});

test('resolveScreenWatchSource：读用户配置，ocr 之外一律回落 main', async () => {
  storedSource = 'ocr';
  assert.equal(await resolveScreenWatchSource(), 'ocr');
  storedSource = 'main';
  assert.equal(await resolveScreenWatchSource(), 'main');
  storedSource = 'nonsense';
  assert.equal(await resolveScreenWatchSource(), 'main', '非法值回落既有行为');
  storedSource = '';
  assert.equal(await resolveScreenWatchSource(), 'main');
});

test('mergeDescriptionIntoUserText：描述拼在后面，原有内容不被覆盖', () => {
  assert.equal(mergeDescriptionIntoUserText('看看屏幕', '画面里有一张表格'), '看看屏幕\n\n画面里有一张表格');
  assert.equal(mergeDescriptionIntoUserText('', '画面里有一张表格'), '画面里有一张表格');
  assert.equal(mergeDescriptionIntoUserText('看看屏幕', ''), '看看屏幕');
  assert.equal(mergeDescriptionIntoUserText('  ', '  '), '');
  assert.equal(mergeDescriptionIntoUserText(null, null), '');
});
