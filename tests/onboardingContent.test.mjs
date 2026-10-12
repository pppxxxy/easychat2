import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const presetEnv = require.resolve('@babel/preset-env');
const sourcePath = path.resolve('src/onboarding/onboardingContent.js');
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
const filename = path.resolve('src/onboarding/onboardingContent.js');
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

test('聊天 API 章节结尾提示：配置后可直接问内置助手', () => {
  const chapter = getOnboardingChapter('chat-api');
  assert.ok(chapter.outro && chapter.outro.body, 'chat-api 章节应有章末提示');
  assert.match(chapter.outro.body, /EasyChat2 助手/);
});

// ---- 未知 chapterId 不得静默变成「空白弹窗」----
//
// 背景：8 处屏把章节 id 手写在字面量里（SettingsScreen / ImageGenScreen / MemoryScreen /
// MomentsView / CharacterDetailScreen / CharacterLibraryScreen），经 setTopic(...) 交给
// ChapterModal → getOnboardingChapters。旧实现 `ids.map(id => CHAPTER_MAP[id]).filter(Boolean)`
// 把未知 id 静默丢掉，整组都认不出时返回空数组 ⇒ 弹窗只剩标题和关闭按钮，无报错无提示。
// 这是结构性风险（当前字面量全部匹配，属潜在而非现网缺陷），所以下面那条机械扫描最值钱。

test('所有 setTopic 字面量都必须是已知章节 id（结构性风险机械化）', () => {
  const ids = new Set(ONBOARDING_CHAPTERS.map(chapter => chapter.id));
  assert.ok(ids.size > 0, '前提：能取到章节 id 集合');

  // 只读源码文本，不去改那 8 处屏（本批所有权外）。
  const root = path.resolve('src');
  const files = fs.readdirSync(root, { recursive: true })
    .filter(name => typeof name === 'string' && name.endsWith('.js'))
    .map(name => path.join(root, name));
  assert.ok(files.length > 100, `前提：确实扫到了 src 下的源码（实际 ${files.length} 个）`);

  const offenders = [];
  let literalCount = 0;
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    // 只认字符串字面量：setTopic(null) / setTopic(topic) 之类不是「手写章节 id」。
    for (const match of source.matchAll(/setTopic\(\s*'([^']*)'\s*\)/g)) {
      literalCount += 1;
      if (!ids.has(match[1])) offenders.push(`${path.relative(root, file)}: setTopic('${match[1]}')`);
    }
  }
  assert.ok(literalCount >= 8, `前提：扫到的 setTopic 字面量数量应覆盖那 8 处屏（实际 ${literalCount}）`);
  assert.deepEqual(offenders, [], `以下 setTopic 字面量不在 CHAPTER_MAP 内（改名/写错会让弹窗空白）：\n${offenders.join('\n')}`);
});

test('未知 chapterId 回退到全量教程，不得返回空数组（空白弹窗）', () => {
  const ids = ONBOARDING_CHAPTERS.map(chapter => chapter.id);
  // 整组都认不出：以前返回 []（ChapterModal 渲染成空白弹窗），现在回退全量。
  assert.deepEqual(
    getOnboardingChapters(['no-such-topic']).map(chapter => chapter.id),
    ids,
    '整组未知时必须回退全量，而不是空数组',
  );
  // 混着写错：保留认得出的那些（既有行为，不得回归成「一个都不显示」）。
  assert.deepEqual(
    getOnboardingChapters(['memory', 'no-such-topic']).map(chapter => chapter.id),
    ['memory'],
  );
  // 空数组/非数组仍按「没有指定 topic」处理 → 全量。
  assert.equal(getOnboardingChapters([]).length, ids.length);
  assert.equal(getOnboardingChapters(null).length, ids.length);

});
