// 工作区面板与设置入口的源码断言（RN 渲染/原生分享依赖运行时，Node 进不去）。
// 钉住：面板存在、以 characterId 分沙盒、写操作受模式门控、Word 导出复用 docx
// 纯函数、设置页有入口。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath) {
  return fs.readFileSync(path.resolve(relativePath), 'utf8');
}

test('WorkspacePanel：可改门控 + 沙盒分维度 + 复用 docx/store', () => {
  const source = readSource('src/WorkspacePanel.js');
  assert.ok(source.includes("mode === 'write'"), '写操作必须仅可改模式');
  assert.ok(source.includes('sandboxDirectory(root, characterId)'), '按 characterId 分沙盒');
  assert.ok(source.includes('listWorkspaceFiles') && source.includes('readWorkspaceFile'), '复用存储层列举/读取');
  assert.ok(source.includes('writeWorkspaceBinaryFile') && source.includes('buildDocxBytes'),
    'Word 导出复用 docx 纯函数与二进制写');
  assert.ok(source.includes('Sharing.shareAsync'), '分享接 expo-sharing');
  assert.ok(source.includes('animationType="slide"'), '面板为滑入式 Modal');
});

test('SettingsScreen：工作区卡片提供面板入口', () => {
  const source = readSource('src/SettingsScreen.js');
  assert.ok(source.includes("from './WorkspacePanel.js'"), '导入工作区面板');
  assert.ok(source.includes('<WorkspacePanel'), '渲染工作区面板');
  assert.ok(/setWorkspaceOpen\(true\)/.test(source), '卡片按钮打开面板');
  assert.ok(source.includes('characterId={characterId}'), '面板按当前角色沙盒传入');
});