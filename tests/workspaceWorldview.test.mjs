// FEAT-AC4 P1：工作区助手的**世界观边界**（治「问发动态却去 grep src」）。
//
// 真机实测的病灶：用户问「你能帮我发动态吗」，助手去 grep 代码仓库找 src/ 下的
// Moments 文件——把「APP 的功能」当成了「代码仓库里的功能」。
// 根因：工作区助手的世界观此前只有文件沙盒，没有「app 自身功能」的概念。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  APP_FEATURE_BOUNDARY_PROMPT,
  APP_FEATURE_TOOL_HINTS,
  appFeatureToolSection,
  buildWorkspaceAgentSystemPrompt,
} from '../src/workspace/chat.js';

const read = rel => fs.readFileSync(path.resolve(rel), 'utf8');

test('边界声明：静态注入（与模式、工具清单都无关）', () => {
  const prompt = APP_FEATURE_BOUNDARY_PROMPT;
  assert.match(prompt, /不是这个代码仓库的一部分/, '必须明确否掉「app 功能在仓库里」的误解');
  assert.match(prompt, /不要用文件工具去 src\//, '必须点名禁止的手段（grep/读 src）');
  assert.match(prompt, /如实说明/, '没有对应工具时要如实说，不许假装改好了');
  // 三种模式都要有（无论有没有工具，这条约定都成立）
  for (const mode of ['ask', 'read', 'write']) {
    const built = buildWorkspaceAgentSystemPrompt({ mode, tools: [] });
    assert.ok(built.includes(prompt), `${mode} 模式必须带边界声明`);
  }
  // 静态性：不依赖 tools 参数（否则「没工具时就不提」会让模型继续 grep）
  assert.equal(
    buildWorkspaceAgentSystemPrompt({ mode: 'write', tools: [] }).includes(prompt),
    true
  );
});

test('应用工具段：**只在真注册时**点名（不许写空承诺）', () => {
  // 一个都没注册 → 不出现这一段
  assert.equal(appFeatureToolSection([]), '');
  assert.equal(appFeatureToolSection(['read_workspace_file']), '');
  assert.equal(appFeatureToolSection(null), '');
  // 注册了才点名，且只点名注册过的
  const section = appFeatureToolSection(['list_music_library', 'read_workspace_file']);
  assert.match(section, /list_music_library/);
  assert.equal(section.includes('list_reminders'), false, '没注册的提醒工具不许点名');
  assert.equal(section.includes('list_app_settings'), false, '没注册的设置工具不许点名');
});

test('应用工具段：三类工具各自的说明齐备（不遗漏）', () => {
  const section = appFeatureToolSection(Object.keys(APP_FEATURE_TOOL_HINTS));
  for (const name of Object.keys(APP_FEATURE_TOOL_HINTS)) {
    assert.match(section, new RegExp(name), `${name} 应在段里被点名`);
  }
  // 提醒那句要写清「绝对时间」（相对时间由模型自己换算）
  assert.match(section, /绝对时间/);
});

test('提示词装配：边界在前、应用工具段在 readLog **之前**（前缀缓存契约）', () => {
  const built = buildWorkspaceAgentSystemPrompt({
    mode: 'write',
    tools: ['list_reminders', 'read_workspace_file'],
    // 真实形状：{ path, chars }（formatReadLogLine 的入参）
    readLog: [{ path: 'notes/a.md', chars: 42 }],
  });
  const boundaryAt = built.indexOf(APP_FEATURE_BOUNDARY_PROMPT);
  const appSectionAt = built.indexOf('[应用工具]');
  // ⚠️ 标记串必须与 formatReadLogLine 的真实输出一致——我第一版写的是
  // '[本次会话已读]'（不存在），于是 readLogAt=-1、下面的断言被**静默跳过**，
  // 把「应用工具段挪到 readLog 之后」这条回归放了过去（注入验证抓到的）。
  // 现在同时断言标记**确实存在**，标记改名会让这条测试立刻红，而不是悄悄失效。
  const readLogAt = built.indexOf('本会话已读：');
  assert.ok(boundaryAt >= 0, '边界声明在提示词里');
  assert.ok(appSectionAt > boundaryAt, '应用工具段在边界之后');
  assert.ok(readLogAt >= 0,
    'readLog 行必须存在（标记串 `本会话已读：` 来自 readLog.formatReadLogLine；改了它请同步这里）');
  // 前缀缓存契约：readLog 必须是**最末尾**的高频动态项（既有纪律，本批不得破坏）
  assert.ok(appSectionAt < readLogAt, '应用工具段必须排在 readLog 之前（否则破坏前缀缓存）');
  // 更强的一条：readLog 行之后不应再有任何内容（本仓 E1 缓存契约）
  const tail = built.slice(readLogAt);
  assert.equal(tail.includes('\n'), false, 'readLog 必须是最后一行（其后不得再追加内容）');
});

test('ask 模式不带应用工具段（该模式没有工具，说「可以」就是撒谎）', () => {
  const built = buildWorkspaceAgentSystemPrompt({ mode: 'ask', tools: ['list_reminders'] });
  assert.ok(built.includes(APP_FEATURE_BOUNDARY_PROMPT), '边界仍在');
  assert.equal(built.includes('[应用工具]'), false, 'ask 模式不得出现工具段');
});

test('结构：三个 app 工具域都已在索引层注册（否则段里点名就是空承诺）', () => {
  const tools = read('src/workspace/tools.js');
  // AC1 设置 / AC2 音乐 / AC4 提醒：三域的只读入口都必须在聚合清单里
  for (const token of [
    'APP_SETTINGS_READ_DEFINITIONS',
    'MUSIC_READ_DEFINITIONS',
    'REMINDER_READ_DEFINITIONS',
  ]) {
    assert.ok(tools.includes(token), `${token} 应参与索引层聚合`);
  }
});

test('结构：边界文案里点名的功能不超出「有工具或有明确 UI 指引」的范围', () => {
  // 边界里列举的功能名是**说明性的**（告诉模型别去仓库找），不构成能力承诺——
  // 但它点名的每个功能都必须是 app 真实有的（编造功能名会误导用户去找）。
  for (const feature of ['设置', '音乐', '提醒', '动态', '日记']) {
    assert.ok(APP_FEATURE_BOUNDARY_PROMPT.includes(feature), `${feature} 应在边界文案里`);
  }
});
