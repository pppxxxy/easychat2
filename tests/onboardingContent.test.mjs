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
  if (request === './disclaimer' || request.endsWith('/disclaimer')) {
    return { __esModule: true, DISCLAIMER_SECTIONS: [] };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const filename = path.resolve('src/onboardingContent.test-runtime.cjs');
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
  assert.equal(ONBOARDING_CHAPTERS.length, 13);
  const chapter = getOnboardingChapters(['chat-media'])[0];
  assert.equal(getOnboardingChapter('chat-media'), chapter);
  assert.equal(chapter.id, 'chat-media');
  assert.match(chapter.intro, /HTML/);
  assert.ok(chapter.items.some(item => item.name === '修改重发'));
});
