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

test('WorkspacePanel：接入 i18n，零硬编码中文（注释除外）', async () => {
  const source = readSource('src/WorkspacePanel.js');
  assert.ok(source.includes('useTranslation'), '接入 useTranslation');
  assert.ok(/const \{ t \} = useTranslation\(\)/.test(source), '取 t');
  const CJK = /[\u4e00-\u9fff]/;
  const offenders = [];
  source.split('\n').forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
    const code = line.replace(/\/\/.*$/, '').replace(/\/\*[^*]*\*\//g, '');
    if (CJK.test(code)) offenders.push(`${index + 1}  ${trimmed.slice(0, 80)}`);
  });
  assert.deepEqual(offenders, [], `WorkspacePanel 仍有硬编码中文：\n${offenders.join('\n')}`);

  const { zhCN } = await import('../src/i18n/locales/zh-CN.js');
  const { en } = await import('../src/i18n/locales/en.js');
  const keys = Object.keys(zhCN).filter(key => key.startsWith('workspace.panel.'));
  assert.ok(keys.length >= 20, `workspace.panel.* 词条数量异常：${keys.length}`);
  assert.deepEqual(keys.filter(key => typeof en[key] !== 'string' || !en[key]), [], '英文缺词条');
  // 占位符中英一致
  const placeholders = text => (String(text).match(/\{(\w+)\}/g) || []).sort().join(',');
  const mismatched = keys.filter(key => placeholders(zhCN[key]) !== placeholders(en[key]));
  assert.deepEqual(mismatched, [], `占位符不一致：${mismatched.join(', ')}`);
  assert.ok(zhCN['chat.tool.status.reading'] && en['chat.tool.status.reading'], '工具气泡词条中英齐全');
  assert.equal(placeholders(zhCN['chat.tool.status.reading']), placeholders(en['chat.tool.status.reading']));
});