// 子代理工具表的**唯一装配点**（回归 2026-10-11 逐行审查 P1-3）。
//
// 缺陷：run_subagent 与 run_workflow 各自拼过一遍「只读来源 + 写来源」。修
// search_workspace（把 SEARCH_TOOL_DEFINITION 并进只读来源）时只改了 subagentTool.js，
// workflowTool.js 没跟上 → 工作流子代理**拿不到搜索工具**，而它的提示词还在让模型
// 用 search_workspace 定位。两份近似代码就是「只修一处」的温床。
//
// 这个文件立两条规矩：
//   1) 行为：两种模式下的工具表内容正确，且**两个调用方用的是同一个函数**；
//   2) 结构：白名单里的每个名字都必须在装配点找得到对应定义——名字在、定义不在就是
//      「提示词让用、实际给不了」这类静默缺口，必须让它在门禁上变红（而不是等人肉审查）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  SUBAGENT_READ_SOURCE,
  SUBAGENT_WRITE_SOURCE,
  buildSubagentTools,
} from '../src/workspace/toolDefs/subagentTools.js';
import { SUBAGENT_TOOL_NAMES, SUBAGENT_WRITE_TOOL_NAMES } from '../src/agent/subagent.js';

test('回归 P1-3：只读工具表含 search_workspace（工作流那侧曾漏掉它）', () => {
  const names = buildSubagentTools('read').map(item => item.name);
  assert.deepEqual(names.sort(), ['list_workspace_files', 'read_workspace_file', 'search_workspace']);
  // 白名单里的每个名字都必须真的装配出定义——「名单有、定义没有」= 模型被提示词引向一个
  // 不存在的工具。这条断言是 P1-3 那一类缺陷（只修一处）的**结构性**拦截。
  for (const name of SUBAGENT_TOOL_NAMES) {
    assert.ok(names.includes(name), `白名单里的 ${name} 必须在装配点找得到定义`);
  }
});

test('回归 P1-3：write 模式在只读表上叠加写工具，且不含递归/执行类', () => {
  const read = buildSubagentTools('read').map(item => item.name);
  const write = buildSubagentTools('write').map(item => item.name);
  assert.deepEqual(write, [...read, 'create_workspace_dir', 'write_workspace_file', 'edit_workspace_file']);
  for (const name of SUBAGENT_WRITE_TOOL_NAMES) {
    assert.ok(write.includes(name), `写白名单里的 ${name} 必须在装配点找得到定义`);
  }
  // 防递归 + 防越权：两条通道都不得出现这些名字。
  for (const forbidden of ['run_subagent', 'run_workflow', 'run_shell', 'run_python', 'run_remote_build']) {
    assert.equal(write.includes(forbidden), false, `${forbidden} 绝不允许进子代理工具表`);
    assert.equal(read.includes(forbidden), false, `${forbidden} 绝不允许进子代理只读表`);
  }
  // 模式归一：非 'write' 一律当只读（fail-closed——写要多一道显式声明）。
  for (const mode of ['read', 'READ', '', null, undefined, 'weird', 'write ']) {
    const names = buildSubagentTools(mode).map(item => item.name);
    assert.equal(
      names.includes('write_workspace_file'),
      false,
      `mode=${String(mode)} 不得拿到写工具（只有精确的 write 才行）`,
    );
  }
});

test('回归 P1-3：两个调用方共用同一个装配函数（源码级：不许再各拼一份）', () => {
  for (const file of ['src/workspace/toolDefs/subagentTool.js', 'src/workspace/toolDefs/workflowTool.js']) {
    const source = fs.readFileSync(path.resolve(file), 'utf8');
    assert.ok(source.includes('buildSubagentTools('), `${file} 必须使用唯一装配点`);
    // 各拼一份的痕迹：直接引用只读/写定义表来手工过滤。
    assert.equal(
      /READ_ONLY_TOOL_DEFINITIONS|WRITE_TOOL_DEFINITIONS|SEARCH_TOOL_DEFINITION/.test(source),
      false,
      `${file} 不得再直接拼工具来源（那正是「只修一处」的入口）`,
    );
  }
  // 装配点自身仍然是「直接引定义、不经注册表」——防递归的第一道结构保证。
  const assembly = fs.readFileSync(path.resolve('src/workspace/toolDefs/subagentTools.js'), 'utf8');
  assert.equal(/from\s+'[^']*registry[^']*'/.test(assembly), false, '装配点不得 import 全局注册表');
  assert.ok(SUBAGENT_READ_SOURCE.length === 3, '只读来源恰好三项（list/read/search）');
  assert.ok(SUBAGENT_WRITE_SOURCE.length === 3, '写来源恰好三项（create/write/edit）');
});
