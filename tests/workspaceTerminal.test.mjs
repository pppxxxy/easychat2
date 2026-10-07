// 终端面板纯逻辑（cwd 解析 / 沙盒路径 / 历史）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  historyWithCommand,
  normalizeCwd,
  resolveTerminalCwd,
  sandboxCwdPath,
  TERMINAL_HISTORY_LIMIT,
} from '../src/workspace/terminal.js';

test('normalizeCwd：. / 空 / ~ 归一成沙盒根，.. 不越界', () => {
  assert.equal(normalizeCwd(''), '.');
  assert.equal(normalizeCwd('.'), '.');
  assert.equal(normalizeCwd('/'), '.');
  assert.equal(normalizeCwd('~'), '.');
  assert.equal(normalizeCwd('a/b'), 'a/b');
  assert.equal(normalizeCwd('/a//b/'), 'a/b');
  assert.equal(normalizeCwd('a/./b'), 'a/b');
  assert.equal(normalizeCwd('a/b/..'), 'a');
  assert.equal(normalizeCwd('..'), '.', '越界被夹回根');
  assert.equal(normalizeCwd('a/../../..'), '.');
});

test('resolveTerminalCwd：cd 相对 / 绝对 / 上级 / 引号 / 非 cd', () => {
  assert.deepEqual(resolveTerminalCwd('.', 'ls -la'), { changed: false, cwd: '.' }, '非 cd 不改 cwd');
  assert.deepEqual(resolveTerminalCwd('.', 'cd src'), { changed: true, cwd: 'src' });
  assert.deepEqual(resolveTerminalCwd('repos/o/r', 'cd main'), { changed: true, cwd: 'repos/o/r/main' });
  assert.deepEqual(resolveTerminalCwd('repos/o/r', 'cd ..'), { changed: true, cwd: 'repos/o' });
  assert.deepEqual(resolveTerminalCwd('repos/o', 'cd /'), { changed: true, cwd: '.' }, '绝对路径按沙盒根算');
  assert.deepEqual(resolveTerminalCwd('repos/o', 'cd /src'), { changed: true, cwd: 'src' });
  assert.deepEqual(resolveTerminalCwd('a', 'cd'), { changed: true, cwd: '.' }, '裸 cd 回根');
  assert.deepEqual(resolveTerminalCwd('a', 'cd ~'), { changed: true, cwd: '.' });
  assert.deepEqual(resolveTerminalCwd('a', 'cd "my dir"'), { changed: true, cwd: 'a/my dir' }, '引号被剥掉');
  assert.deepEqual(resolveTerminalCwd('a/b', 'cd ../../..'), { changed: true, cwd: '.' }, '越界夹回根');
  assert.deepEqual(resolveTerminalCwd('.', 'cdd x'), { changed: false, cwd: '.' }, '不是 cd 命令');
});

test('sandboxCwdPath：沙盒绝对路径 + 相对 cwd', () => {
  assert.equal(sandboxCwdPath('/data/app/workspace', '.'), '/data/app/workspace');
  assert.equal(sandboxCwdPath('/data/app/workspace/', 'a/b'), '/data/app/workspace/a/b');
  assert.equal(sandboxCwdPath('/data/app/workspace', '..'), '/data/app/workspace');
  assert.equal(sandboxCwdPath('', '.'), '');
});

test('historyWithCommand：追加、连续去重、上限裁剪、空命令不记', () => {
  assert.deepEqual(historyWithCommand([], 'ls'), ['ls']);
  assert.deepEqual(historyWithCommand(['ls'], 'ls'), ['ls'], '连续重复只留一条');
  assert.deepEqual(historyWithCommand(['ls'], 'pwd'), ['ls', 'pwd']);
  assert.deepEqual(historyWithCommand(['ls'], '  '), ['ls'], '空命令不记');
  const long = Array.from({ length: TERMINAL_HISTORY_LIMIT + 5 }, (_, i) => `cmd${i}`);
  const trimmed = historyWithCommand(long, 'last');
  assert.equal(trimmed.length, TERMINAL_HISTORY_LIMIT, '超出上限被裁剪');
  assert.equal(trimmed[trimmed.length - 1], 'last');
});

// ---- 面板接线（源码断言；RN 渲染进不了 Node） ----
import fs from 'node:fs';
import path from 'node:path';

const PANEL = fs.readFileSync(path.resolve('src/workspace/screen/TerminalPanel.js'), 'utf8');
const SCREEN = fs.readFileSync(path.resolve('src/workspace/screen/WorkspaceScreen.js'), 'utf8');

test('TerminalPanel：cd 由面板维护、CTRL+C 真杀、如实标注无流式', () => {
  assert.ok(SCREEN.includes('workspace.screen.rail.terminal'), '左栏第五键：终端');
  assert.ok(SCREEN.includes('<TerminalPanel'), '单屏渲染终端面板');
  assert.ok(PANEL.includes('resolveTerminalCwd('), 'cd 由面板解析（独立进程，cwd 靠 cwdPath 传）');
  assert.ok(PANEL.includes('sandboxCwdPath(sandboxDirectoryPath('), '工作目录 = 角色沙盒 + 相对 cwd');
  assert.ok(PANEL.includes('execShellCommand('), '命令走 ShellExecutor');
  assert.ok(PANEL.includes('abortRef.current.abort()'), 'CTRL+C 走 abort → 原生 kill 强杀');
  assert.ok(PANEL.includes('historyWithCommand('), '命令历史（↑↓ 召回）');
  assert.ok(PANEL.includes('truncateShellOutput('), '输出按 64KB 上限截断');
  assert.ok(PANEL.includes('terminalGateReason('), '门控在面板内判定并显示原因');
  assert.ok(PANEL.includes('workspace.terminal.boundary'), '如实标注能力边界');
  assert.ok(PANEL.includes('no streaming') || PANEL.includes('没有流式输出'), '源码注明无流式（命令结束才出结果）');
  assert.ok(!/<Modal/.test(PANEL), '终端面板不自套 Modal');
});
