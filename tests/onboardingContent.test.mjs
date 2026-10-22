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
  // 不断言总数：教程章节会随功能增加而增加，写死数字只会让每次加章节都红一次。
  // 真正要守的是「基础章节没被挤掉」+「每个章节结构完整」。
  assert.ok(ONBOARDING_CHAPTERS.length >= 17, '基础章节不得少于原有 17 章');
  const chapter = getOnboardingChapters(['chat-media'])[0];
  assert.equal(getOnboardingChapter('chat-media'), chapter);
  assert.equal(chapter.id, 'chat-media');
  assert.match(chapter.intro, /HTML/);
  assert.ok(chapter.items.some(item => item.name === '修改重发'));
});

test('教程章节结构完整：id 唯一、必备字段齐全、速查项形状正确', () => {
  const ids = ONBOARDING_CHAPTERS.map(item => item.id);
  assert.equal(new Set(ids).size, ids.length, '章节 id 不得重复（CHAPTER_MAP 会静默覆盖）');
  for (const chapter of ONBOARDING_CHAPTERS) {
    assert.ok(chapter.id, '章节缺 id');
    assert.ok(chapter.title, `${chapter.id} 缺 title`);
    assert.ok(chapter.summary, `${chapter.id} 缺 summary`);
    assert.ok(Array.isArray(chapter.steps) && chapter.steps.length > 0, `${chapter.id} 缺 steps`);
    assert.ok(Array.isArray(chapter.items), `${chapter.id} 的 items 必须是数组`);
    for (const item of chapter.items) {
      assert.ok(item && item.name, `${chapter.id} 有速查项缺 name`);
      assert.ok(item.where, `${chapter.id} 的「${item.name}」缺 where（位置）`);
      assert.ok(item.usage, `${chapter.id} 的「${item.name}」缺 usage（用法）`);
    }
  }
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

// ── 第二批教学章节（2026-10-22 补全） ──────────────────────────────────────
//
// 背景：这 12 个功能此前**完全没有教学**（工作区 / MCP / 音乐 / 书籍 / 世界地图 /
// 语音 / 安全锁 / 主动消息 / 定时任务 / 日记 / 插件 / 备份）。补文案时最容易犯的错
// 是「凭想象写路径」——用户照着点却找不到，比没有教学更糟。
// 所以这里除了结构，还钉「关键路径用词必须与 i18n 真实文案一致」。

test('第二批章节全部存在且挂在正确的位置', () => {
  const expected = [
    'workspace', 'mcp-server', 'music', 'books', 'world-map', 'voice-input',
    'security', 'proactive', 'agent-task', 'diary', 'plugin', 'backup',
  ];
  for (const id of expected) {
    const chapter = getOnboardingChapter(id);
    assert.ok(chapter, `缺少章节 ${id}`);
    assert.ok(chapter.title, `${id} 缺 title`);
    assert.ok(chapter.summary, `${id} 缺 summary`);
    assert.ok(chapter.steps.length >= 3, `${id} 的步骤太少（至少 3 步才讲得清）`);
    assert.ok(chapter.items.length >= 3, `${id} 的速查项太少（至少 3 条）`);
  }
});

test('工作区章节的路径用词与真实设置项一致（照着点能找到）', () => {
  const chapter = getOnboardingChapter('workspace');
  const text = [chapter.intro, ...chapter.steps, ...chapter.items.map(i => `${i.name} ${i.where} ${i.usage}`)]
    .join('\n');
  // 这些是 settings.js 里真实存在的文案，不是编的：
  assert.match(text, /助手工作模式/, '必须提到「助手工作模式」这个真实条目名');
  assert.match(text, /工作区文件夹/, '必须提到「工作区文件夹」');
  assert.match(text, /允许执行命令/, '必须提到「允许执行命令」');
  // 三档模式名与 settings.js 一致
  for (const mode of ['询问', '只读', '可改']) {
    assert.ok(text.includes(mode), `必须说明「${mode}」这一档`);
  }
  // 安全提醒不能少：命令是真实执行的
  assert.match(chapter.note, /真实执行/, '必须明确命令在设备上真实执行');
});

test('MCP 章节讲清风险档位与预览机制', () => {
  const chapter = getOnboardingChapter('mcp-server');
  const text = [chapter.intro, ...chapter.steps, ...chapter.items.map(i => i.where + i.usage), chapter.note].join('\n');
  assert.match(text, /测试连接/, '必须告诉用户怎么验证连接');
  assert.match(text, /只读/, '必须说明只读工具直接放行');
  assert.match(text, /确认/, '必须说明其余工具每次需确认');
  assert.match(text, /永远禁止|永久禁止/, '必须说明删除类操作永久禁止');
});

test('安全锁章节说明「设备无锁屏保护时开不了应用锁」这一真实限制', () => {
  const chapter = getOnboardingChapter('security');
  const text = [chapter.intro, ...chapter.steps, ...chapter.items.map(i => i.where + i.usage), chapter.note].join('\n');
  assert.match(text, /应用锁/);
  assert.match(text, /指纹|面容/, '必须说明依赖生物识别');
  assert.match(text, /锁屏密码/, '必须给出「只有锁屏密码也行」的替代路径');
});

test('备份章节强调「导入会覆盖」与「先备份当前数据」', () => {
  const chapter = getOnboardingChapter('backup');
  const text = [chapter.intro, ...chapter.steps, ...chapter.items.map(i => i.usage), chapter.note].join('\n');
  assert.match(text, /覆盖/, '必须说明导入会覆盖当前内容');
  assert.match(text, /备份/, '必须提示先备份');
  assert.match(text, /完整/, '必须区分完整导出');
  assert.match(text, /快速/, '必须区分快速导出');
});

test('第二批章节的截图键已声明（尚未注册也不得为空）', () => {
  // 图片未注册时 getOnboardingImages 返回空数组、界面自动跳过；
  // 但章节里**必须先把键写下来**，否则补图时无从对照。
  const batch = ONBOARDING_CHAPTERS.slice(-12);
  for (const chapter of batch) {
    const hasImage = Boolean(chapter.image) || (Array.isArray(chapter.images) && chapter.images.length > 0);
    assert.ok(hasImage, `${chapter.id} 没有声明截图键（补图时会找不到对应位置）`);
  }
});
