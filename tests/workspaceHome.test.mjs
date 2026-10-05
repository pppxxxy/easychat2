// 工作区主界面改版的接线断言（RN 组件本身在 Node 里渲染不了，钉源码结构）。
//
// 这一版的核心约定：
//   进来就是聊天；左列四入口 + 预留位；右上退出叉；底部「加号/语音/输入框/设置/发送」；
//   设置按钮展开 8 项列表；综合设置含语言/模式/帮助；子面板（文件/环境/导出）按需打开。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function read(relativePath) {
  return fs.readFileSync(path.resolve(relativePath), 'utf8');
}

const CHAT = read('src/workspace/WorkspaceChat.js');
const SHEET = read('src/workspace/WorkspaceSettingsSheet.js');
const GENERAL = read('src/workspace/WorkspaceGeneralSettings.js');
const PROJECT_SHEET = read('src/workspace/WorkspaceProjectSheet.js');
const PANEL = read('src/WorkspacePanel.js');
const SETTINGS = read('src/SettingsScreen.js');
const ZH = read('src/i18n/locales/zh-CN.js');
const EN = read('src/i18n/locales/en.js');

test('主界面：进来就是聊天，左列四入口 + 预留位，右上退出叉', () => {
  assert.ok(CHAT.includes("t('workspace.rail.newChat')"), '左列：新建对话');
  assert.ok(CHAT.includes("t('workspace.rail.newProject')"), '左列：新建项目');
  assert.ok(CHAT.includes("t('workspace.rail.history')"), '左列：查找历史');
  assert.ok(CHAT.includes("t('workspace.rail.general')"), '左列：综合设置');
  assert.ok(CHAT.includes('railSpacer'), '给后来想到的留了预留位');
  assert.ok(CHAT.includes('styles.railItem'), '左列是竖排按钮');

  // 右上角退出叉（不是标题栏左侧的返回）
  assert.ok(CHAT.includes('styles.exitButton'), '有独立的退出按钮样式');
  assert.ok(/accessibilityLabel=\{t\('workspace\.home\.exit'\)\}/.test(CHAT), '退出按钮有语义标签');

  // 聊天消息区仍然是主体（气泡渲染保留）
  assert.ok(CHAT.includes('bubbleRowUser') && CHAT.includes('bubbleRowAssistant'), '双向气泡保留');
  assert.ok(CHAT.includes('runAgentTurn'), '仍然直连 agent 循环');
});

test('底部一栏：加号 / 语音 / 输入框 / 设置 / 发送', () => {
  const start = CHAT.indexOf('styles.inputBar');
  const end = CHAT.indexOf('\nconst createStyles =');
  assert.ok(start > 0 && end > start, '必须能截出底部输入栏');
  const bar = CHAT.slice(start, end);
  assert.ok(bar.includes('add-circle-outline'), '加号（文件添加）');
  assert.ok(bar.includes('mic-outline'), '语音');
  assert.ok(bar.includes('<TextInput'), '对话框');
  assert.ok(bar.includes('options-outline'), '设置按钮');
  assert.ok(bar.includes('setSettingsOpen(true)'), '设置按钮打开设置列表');
  assert.ok(bar.includes('arrow-up'), '发送按钮');

  // 顺序：加号 → 语音 → 输入框 → 设置 → 发送
  const order = ['add-circle-outline', 'mic-outline', '<TextInput', 'options-outline', 'arrow-up']
    .map(token => bar.indexOf(token));
  assert.ok(order.every(index => index >= 0), '五个控件都在');
  assert.deepEqual([...order].sort((a, b) => a - b), order, '控件顺序必须从左到右依次排列');
});

test('设置列表：八项都在，且各自有落点', () => {
  // 就地展开的五项
  assert.ok(SHEET.includes("id: 'model'"), '模型');
  assert.ok(SHEET.includes("id: 'thinking'"), '思考强度');
  assert.ok(SHEET.includes("id: 'mode'"), '当前工作模式');
  assert.ok(SHEET.includes("id: 'character'"), '当前角色');
  assert.ok(SHEET.includes("id: 'usage'"), '上下文占用');
  // 动作型四项（导入是直接动作，导出/历史/环境走子面板）
  assert.ok(SHEET.includes("id: 'import'"), '导入文件');
  assert.ok(SHEET.includes("id: 'export'"), '导出文件');
  assert.ok(SHEET.includes("id: 'history'"), '查找历史');
  assert.ok(SHEET.includes("id: 'env'"), '环境配置');

  // 上下文占用要能被看到（进度条 + 百分比 + 自动压缩说明）
  assert.ok(SHEET.includes('styles.usageTrack') && SHEET.includes('styles.usageFill'), '占用进度条');
  assert.ok(SHEET.includes("t('workspace.panel.context.hint')"), '压缩说明文案');

  // 导入失败与导出的死路都要有提示，不能点了没反应
  assert.ok(SHEET.includes("t('workspace.settings.import.hint')"), '导入有说明');
  assert.ok(SHEET.includes("t('workspace.settings.export.hint')") && SHEET.includes("onOpenPanel('docx')"),
    '导出明确落到子面板');
});

test('设置项都写回存储（模型 / 思考强度 / 模式 / 角色）', () => {
  assert.ok(CHAT.includes('saveApiConfigs(next, activeId)'), '模型切换写回 API 配置');
  assert.ok(CHAT.includes('saveThinkingSettings(next)'), '思考强度写回全局设置');
  assert.ok(CHAT.includes("patchWorkspaceSettings({ mode: choice })"), '工作模式写回工作区设置');
  assert.ok(CHAT.includes("patchWorkspaceSettings({ assistantCharacterId: next })"), '角色写回工作区设置');
  assert.ok(CHAT.includes('loadUsage'), '上下文占用按当前角色加载');
});

test('综合设置：语言切换 + 模式选择 + 帮助与教学', () => {
  assert.ok(GENERAL.includes("t('workspace.general.language')"), '语言切换项');
  assert.ok(GENERAL.includes('setLocaleId'), '走 I18nContext 的 setLocaleId（与设置页同一份）');
  assert.ok(GENERAL.includes("t('workspace.general.mode')"), '模式选择项');
  assert.ok(GENERAL.includes('onSelectMode'), '模式回调');
  assert.ok(GENERAL.includes("t('workspace.general.help')"), '帮助与教学项');
  assert.ok(GENERAL.includes('TutorialModal'), '帮助落到教学弹层');

  // 左列「综合设置」与底部设置列表都能到达
  assert.ok(CHAT.includes('setGeneralOpen(true)'), '左列入口');
  assert.ok(CHAT.includes('<WorkspaceGeneralSettings'), '组件已接线');
});

test('新建对话与查找历史', () => {
  assert.ok(CHAT.includes('const handleNewChat'), '有新建对话处理');
  assert.ok(/const handleNewChat[\s\S]{0,400}setMessages\(\[\]\)/.test(CHAT), '新建对话清空消息');
  assert.ok(/const handleNewChat[\s\S]{0,500}setAttachments\(\[\]\)/.test(CHAT), '同时清掉附件');
  // 查找历史 → 子面板 viewer
  assert.ok(CHAT.includes("onOpenPanel('viewer')"), '查找历史打开文件/历史子面板');
});

test('新建项目：拉取接线（zipball → 解压 → 写沙盒 → 记入设置）', () => {
  assert.ok(CHAT.includes('parseRepoInput(repo)'), '解析仓库输入');
  assert.ok(CHAT.includes('buildRepoZipUrl('), '拼 zipball 地址');
  assert.ok(CHAT.includes('downloadBinary('), '下载');
  assert.ok(CHAT.includes('extractRepoFiles(bytes)'), '解压');
  assert.ok(CHAT.includes('importProjectToWorkspace({'), '写入沙盒');
  assert.ok(CHAT.includes('patchWorkspaceSettings({ projects: nextProjects, activeProjectId: projectName })'),
    '项目清单与选中项落盘');
  assert.ok(CHAT.includes("mode !== 'write'"), '拉取前要求可改模式（只读/询问下写不进去）');
  assert.ok(CHAT.includes("getGithubMcpSettings()"), '取 GitHub 令牌');
  assert.ok(CHAT.includes("t('workspace.project.err.auth')"), '按错误码给可操作文案');

  // 面板侧：仓库/分支输入 + 已有项目可切换
  assert.ok(PROJECT_SHEET.includes("t('workspace.project.repo')"), '仓库输入');
  assert.ok(PROJECT_SHEET.includes("t('workspace.project.branch')"), '分支输入');
  assert.ok(PROJECT_SHEET.includes("t('workspace.project.pull')"), '拉取按钮');
  assert.ok(PROJECT_SHEET.includes('onSelectProject'), '已有项目可切换');
});

test('入口接线：设置页进的是聊天主界面，子面板按 need 打开并定位', () => {
  assert.ok(SETTINGS.includes("import WorkspaceChat from './workspace/WorkspaceChat.js'"), '引入主界面');
  assert.ok(SETTINGS.includes('<WorkspaceChat'), '主入口渲染的是聊天主界面');
  assert.ok(SETTINGS.includes('onOpenPanel={section => {'), '子面板回调');
  assert.ok(SETTINGS.includes('initialSection={workspacePanelSection}'), '把 section 传给子面板');

  assert.ok(PANEL.includes('initialSection = '), 'WorkspacePanel 接受 initialSection');
  assert.ok(PANEL.includes("if (section === 'viewer')"), 'viewer 定位');
  assert.ok(PANEL.includes("if (section === 'catalog')"), '环境配置定位');
  assert.ok(PANEL.includes('startDocxForm();'), '导出定位到 docx 表单');
  assert.ok(PANEL.includes('openedSectionRef'), '同一 section 不重复弹开');
});

test('新增文案中英齐备', () => {
  const keys = [
    'workspace.home.title',
    'workspace.home.exit',
    'workspace.rail.newChat',
    'workspace.rail.newProject',
    'workspace.rail.history',
    'workspace.rail.general',
    'workspace.settings.title',
    'workspace.settings.model',
    'workspace.settings.thinking',
    'workspace.settings.mode',
    'workspace.settings.character',
    'workspace.settings.usage',
    'workspace.settings.import',
    'workspace.settings.export',
    'workspace.settings.env',
    'workspace.general.title',
    'workspace.general.language',
    'workspace.general.mode',
    'workspace.general.help',
    'workspace.project.title',
    'workspace.project.repo',
    'workspace.project.pull',
    'workspace.project.err.auth',
  ];
  for (const key of keys) {
    assert.ok(ZH.includes(`'${key}'`), `zh-CN 缺 ${key}`);
    assert.ok(EN.includes(`'${key}'`), `en 缺 ${key}`);
  }
});
