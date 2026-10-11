// 工作区记忆文件（AGENTS.md）测试（spec: 2026-10-09-agent-extensibility T2）。
//
// 覆盖：
//  ① 纯函数：UTF-8 字节计数、超长截断（不切断多字节字符）、注入段三态（存在/缺失/超长）；
//  ② 提示组装：带 memory 注入且位于模式说明之前；不带 memory 与旧行为完全一致；
//  ③ IO 薄壳：读取失败/文件不存在安静降级；模板创建幂等、绝不覆盖已有文件；
//  ④ 接线契约：ChatPanel 每轮直读 + 首次创建、capabilities 能力说明、i18n 中英齐。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { buildWorkspaceAgentSystemPrompt, WORKSPACE_AGENT_BASE_PROMPT } from '../src/workspace/chat.js';
import { CAPABILITY_LIMITS } from '../src/workspace/capabilities.js';
import {
  WORKSPACE_MEMORY_FILE,
  WORKSPACE_MEMORY_MAX_BYTES,
  WORKSPACE_MEMORY_TEMPLATE,
  ensureWorkspaceMemory,
  readWorkspaceMemory,
  truncateWorkspaceMemory,
  utf8ByteLength,
  workspaceMemorySection,
} from '../src/workspace/memory.js';

test('utf8ByteLength：ASCII / 中文 / emoji 字节数正确（emoji 是代理对，别数成两个字符）', () => {
  assert.equal(utf8ByteLength('abc'), 3);
  assert.equal(utf8ByteLength('中文'), 6);
  assert.equal(utf8ByteLength('a中'), 4);
  assert.equal(utf8ByteLength('😀'), 4, 'emoji 是 4 字节，不是按 code unit 数出来的 6');
  assert.equal(utf8ByteLength(''), 0);
  assert.equal(utf8ByteLength(null), 0);
});

test('truncateWorkspaceMemory：短文本原样、超长截断到上限内并附提示、极端参数不崩', () => {
  assert.equal(truncateWorkspaceMemory('短内容'), '短内容');
  const long = '中'.repeat(6000); // 18000 字节 > 8192
  const cut = truncateWorkspaceMemory(long);
  assert.ok(utf8ByteLength(cut) <= WORKSPACE_MEMORY_MAX_BYTES, '截断后必须在上限内');
  assert.ok(cut.includes('过长已截断'), '尾部要有明确提示（模型与用户都能看到）');
  assert.ok(cut.startsWith('中'), '前缀内容保留');
  // 不切断多字节字符：按 code point 切，不会出现半个汉字（U+FFFD 是编码坏的信号）
  assert.equal(cut.includes('\uFFFD'), false, '不得切出半个字符');
  // 极端：上限小到装不下提示
  const tiny = truncateWorkspaceMemory('abcdef', 8);
  assert.ok(utf8ByteLength(tiny) <= 8 + utf8ByteLength('\n\n（AGENTS.md 过长已截断：请精简这份记忆文件，超出部分不会生效）'));
});

test('workspaceMemorySection：空内容不注入；有内容时带文件名说明；超长内容注入段仍受控', () => {
  assert.equal(workspaceMemorySection(''), '');
  assert.equal(workspaceMemorySection('   \n  '), '', '全空白等于没有');
  assert.equal(workspaceMemorySection(null), '');
  const section = workspaceMemorySection('回复用中文');
  assert.ok(section.includes(WORKSPACE_MEMORY_FILE), '注入段要说明来源文件');
  assert.ok(section.includes('回复用中文'));
  // K5/K6：记忆是背景上下文，不是指令源。
  assert.ok(section.includes('背景上下文') && section.includes('不是指令'), '措辞纪律：记忆非指令');
  assert.ok(section.includes('以用户请求为准'), '冲突时以用户请求为准');
  const huge = workspaceMemorySection('中'.repeat(6000));
  assert.ok(utf8ByteLength(huge) <= WORKSPACE_MEMORY_MAX_BYTES + 200, '注入段总长受控（含头部说明）');
});

test('buildWorkspaceAgentSystemPrompt：memory 注入在模式说明之前；不传则与旧行为一致', () => {
  const without = buildWorkspaceAgentSystemPrompt({ mode: 'write', characterName: '小助手', tools: ['run_python'] });
  assert.equal(without.includes(WORKSPACE_MEMORY_FILE), false, '没有记忆文件时不得凭空提到它');

  const withMemory = buildWorkspaceAgentSystemPrompt({
    mode: 'write',
    characterName: '小助手',
    tools: ['run_python'],
    memory: '改文件前先备份',
  });
  const memoryIndex = withMemory.indexOf('改文件前先备份');
  const modeIndex = withMemory.indexOf('可改');
  assert.ok(memoryIndex > 0, '记忆内容必须注入');
  assert.ok(memoryIndex < modeIndex, '长期约定（记忆）应排在「这一轮能做什么」（模式说明）之前');
  assert.ok(withMemory.includes(WORKSPACE_AGENT_BASE_PROMPT.slice(0, 8)), '基础提示仍在最前');
  // 空白记忆 = 没有：与不传完全一致
  assert.equal(
    buildWorkspaceAgentSystemPrompt({ mode: 'read', memory: '  ' }),
    buildWorkspaceAgentSystemPrompt({ mode: 'read' }),
    '空白记忆不得改变提示词'
  );
});

test('readWorkspaceMemory：正常/不存在/读失败一律安静降级', async () => {
  // fake 按 characterId 分沙盒（真实 store 就是按角色隔离的——不隔离会误判「不存在」用例）
  const sandboxes = { c1: { [WORKSPACE_MEMORY_FILE]: '约定一' } };
  const store = {
    readWorkspaceFile: async ({ characterId, path: file }) => {
      const bucket = sandboxes[String(characterId)] || {};
      if (!(file in bucket)) throw new Error('fileNotFound');
      return { content: bucket[file] };
    },
  };
  assert.equal(await readWorkspaceMemory(store, 'c1'), '约定一');
  assert.equal(await readWorkspaceMemory(store, 'other'), '', '该角色沙盒里没有文件 → 空串（不是抛错）');
  assert.equal(await readWorkspaceMemory(null, 'c1'), '');
  assert.equal(
    await readWorkspaceMemory({ readWorkspaceFile: async () => { throw new Error('boom'); } }, 'c1'),
    '',
    '读失败 → 空串，不打扰聊天'
  );
});

test('ensureWorkspaceMemory：只在可改模式创建一次、绝不覆盖已有文件、失败静默', async () => {
  const files = {};
  const store = {
    readWorkspaceFile: async ({ path: file }) => {
      if (!(file in files)) throw new Error('fileNotFound');
      return { content: files[file] };
    },
    writeWorkspaceFile: async ({ path: file, content }) => {
      files[file] = content;
      return { path: file };
    },
  };
  assert.equal(await ensureWorkspaceMemory(store, 'c1', 'read'), false, '只读模式不创建');
  assert.equal(await ensureWorkspaceMemory(store, 'c1', 'ask'), false, '询问模式不创建');
  assert.equal(await ensureWorkspaceMemory(store, 'c1', 'write'), true, '首次创建');
  assert.ok(files[WORKSPACE_MEMORY_FILE].includes('# 工作区记忆'), '写入的是模板');
  files[WORKSPACE_MEMORY_FILE] = '我自己改过的约定';
  assert.equal(await ensureWorkspaceMemory(store, 'c1', 'write'), false, '已有文件不覆盖');
  assert.equal(files[WORKSPACE_MEMORY_FILE], '我自己改过的约定', '用户/agent 的内容必须原样保留');
  assert.equal(
    await ensureWorkspaceMemory(
      { readWorkspaceFile: async () => { const e = new Error('nf'); throw e; }, writeWorkspaceFile: async () => { throw new Error('no permission'); } },
      'c1',
      'write'
    ),
    false,
    '无写权限 → false 静默'
  );
});

test('模板自解释：说明自己会被注入、能删、交代项目与约定', () => {
  assert.ok(WORKSPACE_MEMORY_TEMPLATE.includes(WORKSPACE_MEMORY_FILE), '模板里写清自己的文件名');
  assert.ok(WORKSPACE_MEMORY_TEMPLATE.includes('注入'), '说明注入机制');
  assert.ok(WORKSPACE_MEMORY_TEMPLATE.includes('删'), '说明可以删（恢复默认）');
  assert.ok(WORKSPACE_MEMORY_TEMPLATE.includes('项目说明') && WORKSPACE_MEMORY_TEMPLATE.includes('约定'));
});

test('接线契约：ChatPanel 每轮直读 + 首次创建；能力说明与 i18n 齐', () => {
  const panel = fs.readFileSync(path.resolve('src/workspace/screen/ChatPanel.js'), 'utf8');
  assert.ok(panel.includes('readWorkspaceMemory(storeRef.current, ownerId)'), '每轮组装提示前直读记忆');
  assert.ok(panel.includes('ensureWorkspaceMemory(storeRef.current, ownerId, settings.mode)'), '首次打开时创建模板');
  assert.ok(/memory,\n\s*\}\);/.test(panel) || panel.includes('memory,'), 'memory 传进 buildWorkspaceAgentSystemPrompt');
  // 不按 mtime 缓存：源码里不得出现 mtime 缓存相关调用（防未来「顺手优化」引入陈旧指令）
  assert.equal(panel.includes('mtime'), false, '不缓存：agent 自我演进后必须立刻生效');

  const ids = CAPABILITY_LIMITS.map(item => item.id);
  assert.ok(ids.includes('memory'), '能力说明里要如实写 AGENTS.md 机制（可被 agent 改写 → 用户必须知情）');
  const zh = fs.readFileSync(path.resolve('src/i18n/locales/zh-CN/workspace.js'), 'utf8');
  const en = fs.readFileSync(path.resolve('src/i18n/locales/en/workspace.js'), 'utf8');
  assert.ok(zh.includes("'workspace.capability.limit.memory'"), '中文文案在');
  assert.ok(en.includes("'workspace.capability.limit.memory'"), '英文文案在');
});
