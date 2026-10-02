import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const presetEnv = require.resolve('@babel/preset-env');
const sourcePath = path.resolve('src/onboardingContent.js');
const sourceCode = fs.readFileSync(sourcePath, 'utf8');
const transformed = babel.transformSync(sourceCode, {
  babelrc: false,
  configFile: false,
  filename: sourcePath,
  presets: [[presetEnv, { targets: { node: 'current' }, modules: 'commonjs' }]],
}).code;
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === './disclaimer.js' || request.endsWith('/disclaimer')) {
    return { __esModule: true, DISCLAIMER_SECTIONS: [] };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const filename = path.resolve('src/onboardingContent.js');
const runtimeModule = new Module(filename);
runtimeModule.filename = filename;
runtimeModule.paths = Module._nodeModulePaths(path.dirname(filename));
runtimeModule._compile(transformed, filename);
Module._load = originalLoad;
const {
  ONBOARDING_CHAPTERS,
  getOnboardingChapter,
  getOnboardingChapters,
} = runtimeModule.exports;

test('新手教程包含图片、表情包与大角色卡章节', () => {
  assert.equal(ONBOARDING_CHAPTERS.length, 17);
  const chapter = getOnboardingChapters(['chat-media'])[0];
  assert.equal(getOnboardingChapter('chat-media'), chapter);
  assert.equal(chapter.id, 'chat-media');
  assert.match(chapter.intro, /HTML/);
  assert.ok(chapter.items.some(item => item.name === '修改重发'));
});

test('新手教程包含本地模型与本地 API 章节，且说明可复制 /v1 地址', () => {
  const chapter = getOnboardingChapter('local-model');
  assert.ok(chapter, '缺少 local-model 章节');
  assert.ok(chapter.steps.some(step => step.includes('http://127.0.0.1') && step.includes('/v1')),
    '步骤应给出以 /v1 结尾的本地地址');
  assert.ok(chapter.items.some(item => item.name === '复制地址'), '应有复制地址的速查项');
  // 地址固定 127.0.0.1、不对外网开放
  assert.match(chapter.note, /127\.0\.0\.1/);
});

test('新手教程包含世界书、正则脚本与预设章节', () => {
  for (const id of ['lorebook', 'regex', 'presets']) {
    const chapter = getOnboardingChapter(id);
    assert.ok(chapter, `缺少章节 ${id}`);
    assert.ok(chapter.steps.length > 0, `${id} 缺少步骤`);
    assert.ok(chapter.items.length > 0, `${id} 缺少速查项`);
  }
  assert.match(getOnboardingChapter('lorebook').intro, /关键词/);
  assert.match(getOnboardingChapter('presets').intro, /系统提示词/);
});
