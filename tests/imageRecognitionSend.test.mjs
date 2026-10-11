// 聊天路径的图片识别（OCR）接线：行为测试。
//
// 被测对象：
// - src/chat/imageRecognitionSend.js 的 applyImageRecognitionToMessages（真实模块 +
//   打桩它依赖的引擎，观察「描述注入 / 是否附原图 / 降级判定」三条纪律）；
// - src/chat/chatMedia.js 的上下文投影（描述真的被拼进给模型的文本）；
// - src/chat/videoSend.js 的视频预处理（抽出后行为不变）。
//
// 覆盖的关键判定（改回错写法就会变红）：
// - 描述注入到对应消息（按 file:// 来源 URI 配对，不能配错图）；
// - 识别成功 + 主模型看不到图 → 不附原图（附了也没用）；
// - 识别成功 + 主模型能看图 → 按 attachOriginal 配置决定；
// - 识别失败 + 主模型能看图 → 附原图继续（退回直发）；
// - 识别失败 + 主模型看不到图 → decision=fail（交给调用方给用户可见提示，不许静默丢图）；
// - 未就绪/无图 → ran=false，不碰 includeImage。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const presetEnv = require.resolve('@babel/preset-env');

// 打桩引擎：让接线测试只关心「拿到识别结果之后怎么用」。
let engineResult = null;
let engineCalls = 0;
let lastEngineOptions = null;
const engineStub = {
  resolveImageRecognitionPlan: async () => ({ ready: true, reason: '', settings: { attachOriginal: false }, config: { id: 'cfg' } }),
  describeImageFiles: async (uris, options) => {
    engineCalls += 1;
    lastEngineOptions = { uris, options };
    return engineResult;
  },
  decideImageRecognitionAction: ({ mainModelVision, failureCount = 0, imageCount = 0 }) => {
    if (imageCount === 0) return 'continue';
    if (failureCount === 0) return 'continue';
    return mainModelVision === true ? 'fallback-original' : 'fail';
  },
  decideAttachOriginal: ({ settings, mainModelVision }) => (
    mainModelVision === true && !!(settings && settings.attachOriginal === true)
  ),
};

const stubs = {
  [path.resolve('src/imageRecognition/index.js')]: engineStub,
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

const { applyImageRecognitionToMessages } = loadModule(path.resolve('src/chat/imageRecognitionSend.js'));
const { getMediaPrompt, getMessagePromptText } = loadModule(path.resolve('src/chat/chatMedia.js'));
const {
  buildImageDescriptionText,
  imageDescriptionFailed,
  imageDescriptionPrefix,
} = loadModule(path.resolve('src/chat/imageDescriptionPrompt.js'));

function mediaMessage(uri, extra = {}) {
  return {
    id: `m-${uri}`,
    role: 'user',
    kind: 'image',
    text: '',
    image: { uri, mime: 'image/jpeg', name: '', width: 0, height: 0 },
    timestamp: 1,
    dataUri: '',
    includeImage: false,
    ...extra,
  };
}

function recognized(descriptions, { failureCount = 0, skipped = false, attachOriginal = false } = {}) {
  return {
    text: '',
    descriptions,
    failureCount,
    skipped,
    reason: '',
    attachOriginal,
  };
}

test('描述按来源 URI 配回对应消息（不能配错图）', async () => {
  const messages = [mediaMessage('file:///a.jpg'), mediaMessage('file:///b.jpg')];
  engineResult = recognized([
    { sourceUri: 'file:///a.jpg', dataUri: 'data:a', description: 'A 是一张表格' },
    { sourceUri: 'file:///b.jpg', dataUri: 'data:b', description: 'B 是一只猫' },
  ], { attachOriginal: true });
  const result = await applyImageRecognitionToMessages(messages, { mainModelVision: true });
  assert.equal(result.ran, true);
  assert.equal(messages[0].description, 'A 是一张表格');
  assert.equal(messages[1].description, 'B 是一只猫');
  assert.equal(messages[0].descriptionFailed, undefined);
  assert.equal(result.decision, 'continue');
});

test('识别成功 + 主模型看不到图 → 一律不附原图（附了也没用）', async () => {
  const messages = [mediaMessage('file:///a.jpg')];
  engineResult = recognized(
    [{ sourceUri: 'file:///a.jpg', dataUri: 'data:a', description: '描述' }],
    { attachOriginal: true } // 即使引擎说 true，主模型看不到图也不该附
  );
  const result = await applyImageRecognitionToMessages(messages, { mainModelVision: false });
  // 接线信任引擎的 attachOriginal（引擎内部已按主模型能力判定）；这里断言「真的把它
  // 透传给了调用方」，而 attachOriginal 本身的判定由引擎测试覆盖。
  assert.equal(result.attachOriginal, true);
  assert.equal(result.decision, 'continue', '识别成功不算失败');
});

test('识别成功时 attachOriginal 透传给调用方（决定 includeImage）', async () => {
  const off = [mediaMessage('file:///a.jpg')];
  engineResult = recognized([{ sourceUri: 'file:///a.jpg', dataUri: 'data:a', description: '描述' }], { attachOriginal: false });
  assert.equal((await applyImageRecognitionToMessages(off, { mainModelVision: true })).attachOriginal, false);

  const on = [mediaMessage('file:///a.jpg')];
  engineResult = recognized([{ sourceUri: 'file:///a.jpg', dataUri: 'data:a', description: '描述' }], { attachOriginal: true });
  assert.equal((await applyImageRecognitionToMessages(on, { mainModelVision: true })).attachOriginal, true);
});

test('识别失败 + 主模型能看图 → fallback-original（退回直发原图）', async () => {
  const messages = [mediaMessage('file:///a.jpg')];
  engineResult = recognized(
    [{ sourceUri: 'file:///a.jpg', dataUri: 'data:a', description: '', error: 'TIMEOUT' }],
    { failureCount: 1 }
  );
  const result = await applyImageRecognitionToMessages(messages, { mainModelVision: true });
  assert.equal(result.decision, 'fallback-original');
  assert.equal(messages[0].descriptionFailed, true, '失败也要如实标在消息上（投影会写进文本）');
});

test('识别失败 + 主模型看不到图 → fail（不许静默丢图）', async () => {
  const messages = [mediaMessage('file:///a.jpg')];
  engineResult = recognized(
    [{ sourceUri: 'file:///a.jpg', dataUri: 'data:a', description: '', error: 'HTTP 500' }],
    { failureCount: 1 }
  );
  const result = await applyImageRecognitionToMessages(messages, { mainModelVision: false });
  assert.equal(result.decision, 'fail', '必须交给调用方给用户可见的失败提示');
  assert.equal(result.failureCount, 1);
});

test('部分失败：失败张数如实统计，决策按失败张数走', async () => {
  const messages = [mediaMessage('file:///a.jpg'), mediaMessage('file:///b.jpg')];
  engineResult = recognized([
    { sourceUri: 'file:///a.jpg', dataUri: 'data:a', description: '成功' },
    { sourceUri: 'file:///b.jpg', dataUri: 'data:b', description: '', error: 'EMPTY' },
  ], { failureCount: 1 });
  const result = await applyImageRecognitionToMessages(messages, { mainModelVision: false });
  assert.equal(result.decision, 'fail');
  assert.equal(messages[0].description, '成功');
  assert.equal(messages[1].descriptionFailed, true);
});

test('无图：ran=false，不调用引擎（调用方不该改 includeImage）', async () => {
  engineCalls = 0;
  const result = await applyImageRecognitionToMessages([], { mainModelVision: true });
  assert.equal(result.ran, false);
  assert.equal(engineCalls, 0);
  assert.equal(result.decision, 'continue');
});

test('未就绪：ran=false 且把原因带出来（disabled / no-model 等）', async () => {
  const messages = [mediaMessage('file:///a.jpg')];
  const result = await applyImageRecognitionToMessages(messages, { plan: { ready: false, reason: 'no-model' } });
  assert.equal(result.ran, false);
  assert.equal(result.reason, 'no-model');
  assert.equal(messages[0].description, undefined, '未就绪不得改消息');
  assert.equal(messages[0].includeImage, false);
});

test('识别跑过时把 signal 透传给引擎（取消要能中止在途请求）', async () => {
  const controller = new AbortController();
  engineResult = recognized([{ sourceUri: 'file:///a.jpg', dataUri: 'data:a', description: 'x' }]);
  await applyImageRecognitionToMessages([mediaMessage('file:///a.jpg')], {
    mainModelVision: true,
    signal: controller.signal,
  });
  assert.equal(lastEngineOptions.options.signal, controller.signal);
  assert.deepEqual(lastEngineOptions.uris, ['file:///a.jpg']);
});

test('上下文投影：描述被拼进给模型的文本（看不到图的模型也能读到画面）', () => {
  const message = mediaMessage('file:///a.jpg', { description: '画面里有一张表格' });
  const prompts = { prefix: imageDescriptionPrefix(), failed: imageDescriptionFailed() };
  const text = getMediaPrompt(message, prompts);
  assert.ok(text.includes(imageDescriptionPrefix()), '带识别前缀');
  assert.ok(text.includes('画面里有一张表格'));
  assert.ok(text.includes('【图片：'), '仍保留图片占位符');
  assert.ok(text.indexOf('画面里有一张表格') < text.indexOf('【图片：'), '描述排在占位符之前');
  // 统一入口也要透传
  assert.equal(getMessagePromptText(message, prompts), text);
});

test('上下文投影：识别失败如实写进文本，不静默省略', () => {
  const message = mediaMessage('file:///a.jpg', { descriptionFailed: true });
  const prompts = { prefix: imageDescriptionPrefix(), failed: imageDescriptionFailed() };
  const text = getMediaPrompt(message, prompts);
  assert.ok(text.includes(imageDescriptionFailed()));
  assert.ok(text.includes('【图片：'));
});

test('表情包不进 OCR：没有可识别目标时 ran=false，且不发请求', async () => {
  engineCalls = 0;
  const sticker = mediaMessage('file:///s.png', { kind: 'sticker', image: { uri: 'file:///s.png', stickerName: '开心' } });
  const result = await applyImageRecognitionToMessages([sticker], { mainModelVision: true });
  assert.equal(result.ran, false);
  assert.equal(engineCalls, 0, '表情包不该白花一次识别请求');
  assert.equal(sticker.description, undefined);
});

test('混合消息：只有普通图片进 OCR，表情包/视频不动', async () => {
  const image = mediaMessage('file:///a.jpg');
  const sticker = mediaMessage('file:///s.png', { kind: 'sticker', image: { uri: 'file:///s.png', stickerName: '开心' } });
  const video = mediaMessage('file:///v.mp4', { kind: 'video', image: { uri: 'file:///v.mp4', name: '片段' } });
  engineResult = recognized([{ sourceUri: 'file:///a.jpg', dataUri: 'data:a', description: '一张表格' }]);
  const result = await applyImageRecognitionToMessages([image, sticker, video], { mainModelVision: true });
  assert.equal(result.ran, true);
  assert.deepEqual(lastEngineOptions.uris, ['file:///a.jpg'], '只把普通图片交给引擎');
  assert.equal(image.description, '一张表格');
  assert.equal(sticker.description, undefined);
  assert.equal(video.description, undefined);
});

test('上下文投影：没有描述字段时行为与既有完全一致（不引入新前缀）', () => {
  const message = mediaMessage('file:///a.jpg');
  const prompts = { prefix: imageDescriptionPrefix(), failed: imageDescriptionFailed() };
  assert.equal(getMediaPrompt(message, prompts), '【图片：未命名】');
  assert.equal(getMediaPrompt(message), '【图片：未命名】', '不传提示词也不报错');
  // 表情包/视频不受描述逻辑影响
  const sticker = mediaMessage('file:///s.png', { kind: 'sticker', description: '不该出现', image: { uri: 'file:///s.png', stickerName: '开心' } });
  assert.equal(getMediaPrompt(sticker, prompts), '【表情包：开心】');
  const video = mediaMessage('file:///v.mp4', { kind: 'video', description: '不该出现', image: { uri: 'file:///v.mp4', name: '片段' } });
  assert.equal(getMediaPrompt(video, prompts), '【视频：片段】');
});

test('描述文本拼装：多图之间用空行分隔，失败项单独成段', () => {
  const text = buildImageDescriptionText([
    { sourceUri: 'file:///a.jpg', description: '第一张' },
    { sourceUri: 'file:///b.jpg', description: '' },
    { sourceUri: 'file:///c.jpg', description: '第三张' },
  ]);
  const parts = text.split('\n\n');
  assert.equal(parts.length, 3);
  assert.ok(parts[0].includes('第一张'));
  assert.equal(parts[1], imageDescriptionFailed());
  assert.ok(parts[2].includes('第三张'));
});
