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
  // 面板不再自己拼 uri：换成后端接口，角色隔离由 store 以 characterId 分沙盒保证；
// ownerId 允许显式传入（打开面板解析出工作区角色后立即用新 id 刷新列表）。
  assert.ok(/listWorkspaceFiles\(\{ characterId: ownerId \}\)/.test(source), '列表按 characterId 分沙盒');
  assert.ok(/readWorkspaceFile\(\{ characterId, path/.test(source), '读取按 characterId 分沙盒');
  assert.ok(source.includes('createWorkspaceStore') && source.includes('describeWorkspaceRoot'),
    '根与后端按当前设置解析（应用内 / 外部文件夹）');
  assert.ok(!source.includes('expo-file-system/legacy'), '面板不得直连 legacy 文件系统：读写须经后端');
  assert.ok(source.includes('writeWorkspaceBinaryFile') && source.includes('buildDocxBytes'),
    'Word 导出复用 docx 纯函数与二进制写');
  assert.ok(source.includes('Sharing.shareAsync'), '分享接 expo-sharing');
  assert.ok(source.includes('animationType="slide"'), '面板为滑入式 Modal');
  assert.ok(/container:\s*\{[^}]*paddingTop/.test(source), '全屏容器需顶部内边距，避免标题/关闭贴到状态栏');
  // 工作区角色：打开时解析（未设置落到默认工作助手）+ 选择器可切换并写回设置。
  assert.ok(source.includes('resolveWorkspaceAssistant'), '打开面板解析工作区角色');
  // 断言必须钉住「解析路径」的专属串（resolved.id）——选择器路径里也有一处
  // patchWorkspaceSettings 调用，只查前缀会漏掉解析路径被拆掉的回归（注入验证抓出）。
  assert.ok(source.includes('patchWorkspaceSettings({ assistantCharacterId: resolved.id })'), '解析出的角色写回设置');
  assert.ok(source.includes('patchWorkspaceSettings({ assistantCharacterId: item.id })'), '选择角色写回设置');
  assert.ok(source.includes('getCharacterLibrary'), '选择器读取角色库');
  // 状态条重排后：角色选择收进状态条的角色芯片（打开既有选择器）。
  assert.ok(/onPress=\{openCharacterPicker\}/.test(source), '状态条角色芯片有选择入口');
  // 查看文件：两段（文件/历史改动）+ 历史从存储域读取 + 清空入口。
  assert.ok(source.includes("t('workspace.panel.viewFiles')"), '面板有查看文件入口');
  assert.ok(source.includes('getWorkspaceChanges'), '历史改动读取存储域');
  assert.ok(source.includes('clearWorkspaceChanges'), '历史可清空');
  assert.ok(source.includes("openViewer('history')") || source.includes("openViewer(tab)"), '分段切换走 openViewer');
});

test('SettingsScreen：工作区卡片打开的是单屏（不再是平级面板 Modal）', () => {
  // 工作区卡片 UI 在 settings/sections/WorkspaceSection.js；入口装配在 SettingsScreen。
  const card = readSource('src/settings/sections/WorkspaceSection.js');
  const settings = readSource('src/SettingsScreen.js');
  assert.ok(/setWorkspaceOpen\(true\)/.test(card), '卡片按钮打开工作区');
  assert.ok(settings.includes("from './workspace/screen/WorkspaceScreen.js'"), '设置页挂的是工作区单屏');
  assert.ok(settings.includes('<WorkspaceScreen'), '渲染工作区单屏');
  assert.ok(!settings.includes('<WorkspacePanel'), '设置页不得再直接渲染 WorkspacePanel');
  assert.ok(!settings.includes('<WorkspaceChat'), '设置页不得再直接渲染 WorkspaceChat');
});

test('SettingsScreen：选文件夹 + 命令开关都走 patch（不许整体 save 冲掉彼此）', () => {
  // 快赢2 后状态与写入逻辑在 settings/useWorkspaceSettings.js；工作区卡片 UI 在 WorkspaceSection。
  const source = readSource('src/settings/useWorkspaceSettings.js') + readSource('src/settings/sections/WorkspaceSection.js');
  assert.ok(/from '\.\.?\/workspace\/picker\.js'/.test(source), '接入选文件夹能力');
  assert.ok(source.includes('pickWorkspaceFolder()'), '调用系统目录选择器');
  assert.ok(/patchWorkspaceSettings\(\{ location:/.test(source), '文件夹走局部更新');
  assert.ok(/patchWorkspaceSettings\(\{ allowCommandExecution/.test(source), '命令开关走局部更新');
  // 改模式那次是最容易踩坑的地方：必须是 patch，不能是整体 save
  assert.ok(/await patchWorkspaceSettings\(\{ mode \}\)/.test(source), '改模式必须走 patchWorkspaceSettings');
  assert.equal(/saveWorkspaceSettings\(/.test(source), false, '设置页不得再整体写工作区设置');
  // 命令开关要有二次确认，且只在可改模式、非外部根时可点
  assert.ok(source.includes("t('settings.workspace.shell.confirm.title')"), '开启命令执行要二次确认');
  assert.ok(/disabled=\{workspaceMode !== 'write' \|\| workspaceFolder\.kind === WORKSPACE_ROOT_KINDS\.SAF\}/.test(source),
    '只读模式或外部根下开关不可点');
  // 工作区卡片里的硬编码「打开工作区」必须已迁到 t()
  assert.equal(source.includes('title="打开工作区"'), false, '工作区卡片的按钮文案必须走 i18n');
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
test('能力说明卡片：接入 i18n、零硬编码中文、按当前设置渲染', () => {
  const source = readSource('src/WorkspaceCapabilitiesCard.js');
  assert.ok(source.includes('useTranslation') && /const \{ t \} = useTranslation\(\)/.test(source), '接入 i18n');
  assert.ok(source.includes('capabilityViewModel'), '结构来自纯数据模块');
  const CJK = /[\u4e00-\u9fff]/;
  const offenders = [];
  source.split('\n').forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
    const code = line.replace(/\/\/.*$/, '').replace(/\/\*[^*]*\*\//g, '');
    if (CJK.test(code)) offenders.push(`${index + 1}  ${trimmed.slice(0, 80)}`);
  });
  assert.deepEqual(offenders, [], `能力说明卡片仍有硬编码中文：\n${offenders.join('\n')}`);
  // 设置页必须把它渲染进工作区卡片，并传入当前设置与 shell 可用性
  // （工作区卡片 UI 已拆到 settings/sections/WorkspaceSection.js）
  const settings = readSource('src/settings/sections/WorkspaceSection.js');
  assert.ok(settings.includes('<WorkspaceCapabilitiesCard'), '设置页渲染能力说明卡片');
  assert.ok(/settings=\{\{[\s\S]{0,200}allowCommandExecution: commandExecution/.test(settings), '传入当前工作区设置');
  assert.ok(/shellAvailable=\{isShellAvailable\(\)\}/.test(settings), '传入 shell 是否可用');
});

test('WorkspacePanel：思考强度与上下文占用接线钉死在源码', () => {
  const source = readSource('src/WorkspacePanel.js');
  // 思考强度：四档 chips（off=关闭思考），点选立即保存，打开面板回读当前档位。
  assert.ok(source.includes("const THINKING_CHOICES = ['off', 'low', 'medium', 'high'];"), '四档可选');
  assert.ok(source.includes('saveThinkingSettings(next)'), '点选立即保存');
  assert.ok(source.includes("enabled: choice !== 'off'"), 'off 关闭思考');
  assert.ok(source.includes('t(`workspace.panel.thinking.${choice}`)'), '档位文案走词条');
  assert.ok(source.includes('getThinkingSettings()'), '打开时回读当前强度');
  // 上下文占用：与 ChatScreen.maybeAutoSummarize 同一口径；无会话显示空态。
  assert.ok(
    source.includes("import { AUTO_COMPACT_RATIO, computeContextUsage, resolveContextWindow } from './chat/contextUsage.js';"),
    '复用 contextUsage 纯口径'
  );
  // 钉住「过滤 + 排序」整体：两条相邻断言分别锁 type 过滤与 characterId 匹配，
  // 任何一条被拆掉都会漏占用（曾经靠注入验证抓过这类半截匹配）。
  assert.ok(
    source.includes(".filter(item => item && item.type !== 'group'"),
    '占用只统计单聊会话（排除群聊）'
  );
  assert.ok(
    source.includes("String(item.characterId || '') === String(ownerId || '')"),
    '占用取当前工作区角色的会话'
  );
  assert.ok(
    source.includes('declared: caps.contextWindow,'),
    '窗口按每模型声明的 contextWindow'
  );
  assert.ok(
    source.includes('usage.ratio >= AUTO_COMPACT_RATIO && styles.contextFillWarn'),
    '到 80% 线进度条转警示色'
  );
  assert.ok(
    source.includes("t('workspace.panel.context.usage', {"),
    '占用文案走词条（token 数与百分比）'
  );
  assert.ok(
    source.includes("t('workspace.panel.context.empty')"),
    '无会话有空态文案'
  );
});
