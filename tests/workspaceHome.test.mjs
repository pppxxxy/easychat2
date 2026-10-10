// 工作区单屏的接线断言（RN 组件本身在 Node 里渲染不了，钉源码结构）。
//
// 架构（v2/v3，Stage 1-5 落地后）：
//   设置页只挂一个 WorkspaceScreen（唯一 Modal）；左栏四个领域键（对话/文件/GitHub/设置）；
//   对话面板 ChatPanel、文件面板 FilesPanel、GitHub 工作台 GithubPanel、设置面板
//   WorkspaceSettingsPanel，任一时刻只渲染一个。旧的 WorkspaceChat / WorkspacePanel /
//   WorkspaceRepoSheet / WorkspaceProjectSheet 已迁走或删除。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { localeSource } from './helpers/localeSource.mjs';

function read(relativePath) {
  return fs.readFileSync(path.resolve(relativePath), 'utf8');
}

const CHAT = read('src/workspace/screen/ChatPanel.js');
const PANEL = read('src/workspace/screen/FilesPanel.js');
const SCREEN = read('src/workspace/screen/WorkspaceScreen.js');
const SHEET = read('src/workspace/WorkspaceSettingsSheet.js');
const HISTORY = read('src/workspace/WorkspaceHistorySheet.js');
const GENERAL = read('src/workspace/WorkspaceGeneralSettings.js');
const SETTINGS = read('src/SettingsScreen.js');
const ZH = localeSource('src/i18n/locales/zh-CN');
const EN = localeSource('src/i18n/locales/en');

test('对话面板：紧凑动作行 + 气泡主体 + 直连 agent', () => {
  assert.ok(CHAT.includes("t('workspace.rail.newChat')"), '动作行：新建对话');
  assert.ok(CHAT.includes("t('workspace.rail.history')"), '动作行：查找历史');
  assert.ok(CHAT.includes('styles.embeddedBar'), '紧凑动作行');
  // 单屏的职责：左栏与顶栏不再由对话面板自带。
  assert.ok(!CHAT.includes('styles.railItem'), '不再自带左栏');
  assert.ok(!CHAT.includes('styles.topBar'), '不再自带顶栏');

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
  assert.ok(bar.includes('setSettingsOpen(true)'), '设置按钮打开设置层');
  assert.ok(bar.includes('arrow-up'), '发送按钮');

  const order = ['add-circle-outline', 'mic-outline', '<TextInput', 'options-outline', 'arrow-up']
    .map(token => bar.indexOf(token));
  assert.ok(order.every(index => index >= 0), '五个控件都在');
  assert.deepEqual([...order].sort((a, b) => a - b), order, '控件顺序必须从左到右依次排列');
});

test('设置层：八项都在，且各自有落点', () => {
  assert.ok(SHEET.includes("id: 'model'"), '模型');
  assert.ok(SHEET.includes("id: 'thinking'"), '思考强度');
  assert.ok(SHEET.includes("id: 'mode'"), '当前工作模式');
  assert.ok(SHEET.includes("id: 'character'"), '当前角色');
  assert.ok(SHEET.includes("id: 'usage'"), '上下文占用');
  assert.ok(SHEET.includes("id: 'import'"), '导入文件');
  assert.ok(SHEET.includes("id: 'export'"), '导出文件');
  assert.ok(SHEET.includes("id: 'history'"), '查找历史');
  assert.ok(SHEET.includes("id: 'env'"), '环境配置');

  assert.ok(SHEET.includes('styles.usageTrack') && SHEET.includes('styles.usageFill'), '占用进度条');
  assert.ok(SHEET.includes("t('workspace.panel.context.hint')"), '压缩说明文案');
  assert.ok(SHEET.includes("t('workspace.settings.import.hint')"), '导入有说明');
  assert.ok(SHEET.includes("t('workspace.settings.export.hint')") && SHEET.includes("onOpenPanel('docx')"),
    '导出明确落到文件面板');
});

test('设置项都写回存储（模型 / 思考强度 / 模式 / 角色）', () => {
  assert.ok(CHAT.includes('saveApiConfigs(next, activeId)'), '模型切换写回 API 配置');
  assert.ok(CHAT.includes('saveThinkingSettings(next)'), '思考强度写回全局设置');
  assert.ok(CHAT.includes("patchWorkspaceSettings({ mode: choice })"), '工作模式写回工作区设置');
  assert.ok(CHAT.includes("patchWorkspaceSettings({ assistantCharacterId: next })"), '角色写回工作区设置');
  assert.ok(CHAT.includes('loadUsage'), '上下文占用按当前角色加载');
});

test('综合设置：语言 + 模式 + 帮助，落在设置面板内', () => {
  assert.ok(GENERAL.includes("t('workspace.general.language')"), '语言切换项');
  assert.ok(GENERAL.includes('setLocaleId'), '走 I18nContext 的 setLocaleId（与设置页同一份）');
  assert.ok(GENERAL.includes("t('workspace.general.mode')"), '模式选择项');
  assert.ok(GENERAL.includes('onSelectMode'), '模式回调');
  assert.ok(GENERAL.includes("t('workspace.general.help')"), '帮助与教学项');
  assert.ok(GENERAL.includes('TutorialModal'), '帮助落到教学弹层');

  // 单屏下旧左栏不可达：语言/帮助的唯一入口是设置面板（内嵌）。
  const SETTINGS_PANEL = read('src/workspace/screen/WorkspaceSettingsPanel.js');
  assert.ok(SETTINGS_PANEL.includes('<WorkspaceGeneralSettings'), '设置面板已接线');
});

test('新建对话与查找历史', () => {
  assert.ok(CHAT.includes('const handleNewChat'), '有新建对话处理');
  assert.ok(/const handleNewChat[\s\S]{0,400}setMessages\(\[\]\)/.test(CHAT), '新建对话清空消息');
  assert.ok(/const handleNewChat[\s\S]{0,500}setAttachments\(\[\]\)/.test(CHAT), '同时清掉附件');
  assert.ok(CHAT.includes("onOpenPanel('viewer')"), '文件与历史改动深链到文件面板');
});

test('导入只有一套 UI：聊天侧不再有项目拉取', () => {
  assert.ok(!CHAT.includes('importProjectToWorkspace'), '聊天侧项目导入已移除');
  assert.ok(!CHAT.includes('WorkspaceProjectSheet'), '旧「新建项目」弹层已删除');
  const github = read('src/workspace/screen/GithubPanel.js');
  assert.ok(github.includes('listRepos('), '导入/仓库管理统一在 GitHub 工作台');
});

test('入口接线：设置页只挂一个工作区单屏，四领域面板由单屏内部分发', () => {
  assert.ok(SETTINGS.includes("import WorkspaceScreen from './workspace/screen/WorkspaceScreen.js'"), '引入单屏');
  assert.ok(SETTINGS.includes('<WorkspaceScreen'), '主入口渲染的是单屏');
  assert.ok(!/from\s+'[^']*WorkspacePanel\.js'/.test(SETTINGS), '设置页不得再引入 WorkspacePanel');
  assert.ok(!/<WorkspacePanel/.test(SETTINGS), '设置页不得再渲染 WorkspacePanel');
  assert.ok(!/from\s+'[^']*WorkspaceChat\.js'/.test(SETTINGS), '设置页不得再引入 WorkspaceChat');
  assert.ok(!/<WorkspaceChat/.test(SETTINGS), '设置页不得再渲染 WorkspaceChat');
  assert.ok(!SETTINGS.includes('onOpenPanel'), '设置页不再持有子面板回调状态');
  assert.ok(!SETTINGS.includes('workspacePanelOpen'), '三层堆叠的旧状态已删除');

  // 单屏本身：左栏四领域键 + 面板宿主。
  assert.ok(SCREEN.includes("workspace.screen.rail.chat"), '左栏：对话');
  assert.ok(SCREEN.includes("workspace.screen.rail.files"), '左栏：文件');
  assert.ok(SCREEN.includes("workspace.screen.rail.github"), '左栏：GitHub');
  assert.ok(SCREEN.includes("workspace.screen.rail.terminal"), '左栏：终端');
  assert.ok(SCREEN.includes("workspace.screen.rail.settings"), '左栏：设置');
  assert.ok(SCREEN.includes("useState('chat')"), '默认落在对话面板');
  assert.ok(SCREEN.includes('<ChatPanel'), '对话面板');
  assert.ok(SCREEN.includes('<FilesPanel'), '文件面板');
  assert.ok(SCREEN.includes('GithubPanel'), 'GitHub 面板');
  assert.ok(SCREEN.includes('TerminalPanel'), '终端面板');
  assert.ok(SCREEN.includes('WorkspaceSettingsPanel'), '设置面板');
  // 面板分发：单屏按 panel 分发。P1 起抽成 renderChatPanel / renderDomainPanel 两个函数
  //（宽屏两栏复用同一对函数，避免两套分发各写一遍）——契约没变，只是从内联条件变成具名分发。
  assert.ok(SCREEN.includes("panel === 'chat'"), '对话与其他领域互斥');
  assert.ok(SCREEN.includes("id === 'files'") && SCREEN.includes("id === 'github'"), '领域面板由单屏分发');
  assert.ok(SCREEN.includes('renderDomainPanel') && SCREEN.includes('renderChatPanel'), '分发函数存在');

  assert.ok(PANEL.includes('initialSection = '), '文件面板接受 initialSection');
  assert.ok(PANEL.includes("if (section === 'viewer')"), 'viewer 定位');
  assert.ok(PANEL.includes("if (section === 'catalog')"), '环境配置定位');
  assert.ok(PANEL.includes('startDocxForm();'), '导出定位到 docx 表单');
  assert.ok(PANEL.includes('openedSectionRef'), '同一 section 不重复弹开');
});

test('旧件已迁走/删除，且面板不再自套 Modal', () => {
  assert.equal(fs.existsSync(path.resolve('src/WorkspacePanel.js')), false, 'WorkspacePanel.js 已迁至 screen/FilesPanel.js');
  assert.equal(fs.existsSync(path.resolve('src/workspace/WorkspaceChat.js')), false, 'WorkspaceChat.js 已迁至 screen/ChatPanel.js');
  assert.equal(fs.existsSync(path.resolve('src/workspace/WorkspaceRepoSheet.js')), false, '旧 GitHub 弹层已删除');
  assert.equal(fs.existsSync(path.resolve('src/workspace/WorkspaceProjectSheet.js')), false, '旧新建项目弹层已删除');
  assert.ok(!/<Modal visible=\{visible\}/.test(PANEL), '文件面板不再是自套 Modal 的组件');
  assert.ok(!/<Modal visible=\{visible\}/.test(CHAT), '对话面板不再是自套 Modal 的组件');
});

test('工作区会话持久化：发送即落盘，可切换 / 删除 / 清空，切角色换历史', () => {
  assert.ok(CHAT.includes('persistMessages(ownerId, chatId, [userMessage])'), '发送时落 user 消息');
  assert.ok(
    CHAT.includes('persistMessages(ownerId, chatId, [{ ...assistantFinal, at: Date.now() }])'),
    '助手终稿一次性落盘'
  );
  assert.ok(CHAT.includes('const chatId = activeChatId;'), '会话 id 在发送时定住（生成中切会话不写错）');
  assert.ok(CHAT.includes('const ownerId = characterId;'), '角色同时定住');
  assert.ok(CHAT.includes('getWorkspaceChats(ownerId)'), '打开时载入该角色的会话');
  assert.ok(CHAT.includes('createWorkspaceChat(characterId)'), '新建对话另开会话（不是清掉上一条）');
  assert.ok(CHAT.includes('setActiveWorkspaceChat(characterId, id)'), '切换会话即持久化');
  assert.ok(CHAT.includes('deleteWorkspaceChat(characterId, id)'), '删除会话');
  assert.ok(CHAT.includes('clearWorkspaceChats(characterId)'), '清空历史');
  assert.ok(CHAT.includes('await loadChats(next);'), '切角色时换一整套历史');

  assert.ok(CHAT.includes('setHistoryOpen(true)'), '动作行打开对话历史');
  assert.ok(CHAT.includes('<WorkspaceHistorySheet'), '历史面板已接线');
  assert.ok(SHEET.includes("onOpenPanel('viewer')"), '文件与改动深链到文件面板');

  assert.ok(HISTORY.includes('onSelectChat'), '点击切换');
  assert.ok(HISTORY.includes('confirmDelete'), '删除有二次确认');
  assert.ok(HISTORY.includes('confirmClear'), '清空有二次确认');
  assert.ok(HISTORY.includes("t('workspace.history.empty')"), '空态文案');
  assert.ok(HISTORY.includes("t('workspace.history.count'"), '显示消息条数');

  assert.ok(
    read('src/storage/workspace.js').includes("WORKSPACE_CHATS_KEY = '@easychat2_workspace_chats'"),
    '工作区会话走独立键'
  );
});

test('新增文案中英齐备', () => {
  const keys = [
    'workspace.home.title',
    'workspace.home.exit',
    'workspace.rail.newChat',
    'workspace.rail.history',
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
    'workspace.history.title',
    'workspace.history.empty',
    'workspace.history.untitled',
    'workspace.history.clear.action',
    'workspace.settings.files',
    'workspace.screen.rail.chat',
    'workspace.screen.rail.files',
    'workspace.screen.rail.github',
    'workspace.screen.rail.settings',
  ];
  for (const key of keys) {
    assert.ok(ZH.includes(`'${key}'`), `zh-CN 缺 ${key}`);
    assert.ok(EN.includes(`'${key}'`), `en 缺 ${key}`);
  }
});

test('Stage 4：对话面板内嵌设置层，设置面板收编语言/模式/帮助', () => {
  const SETTINGS_PANEL = read('src/workspace/screen/WorkspaceSettingsPanel.js');
  const SETTINGS_SHEET = read('src/workspace/WorkspaceSettingsSheet.js');

  assert.ok(SETTINGS_PANEL.includes('<WorkspaceGeneralSettings'), '设置面板内嵌综合设置');
  assert.ok(SETTINGS_PANEL.includes('embedded'), '内嵌模式');
  assert.ok(GENERAL.includes('embedded = false'), 'GeneralSettings 支持 embedded');
  assert.ok(GENERAL.includes('styles.embeddedRoot'), 'embedded 有独立外壳样式');

  assert.ok(SETTINGS_SHEET.includes('embedded = false'), 'SettingsSheet 支持 embedded');
  assert.ok(CHAT.includes('settingsOpen ? ('), '对话面板内嵌设置层');
  assert.ok(!CHAT.includes('<Modal'), '对话面板不再有 Modal');

  assert.ok(SCREEN.includes('initialSection={filesSection}'), '深链 section 传给文件面板');
  assert.ok(SCREEN.includes('setFilesSection(String(section'), 'openFiles 记录 section');
});

test('跨面板交接：GitHub 工作台 → 对话面板输入框', () => {
  assert.ok(SCREEN.includes('handoffToChat'), '单屏持有交接回调');
  assert.ok(SCREEN.includes('onHandoff={handoffToChat}'), 'GitHub 面板接上交接');
  assert.ok(SCREEN.includes('draft={draft}'), '草稿传给对话面板');
  assert.ok(SCREEN.includes("setPanel('chat')"), '交接后切到对话面板');
  assert.ok(CHAT.includes('consumedDraftRef'), '对话面板消费草稿（token 去重）');
  assert.ok(CHAT.includes('setInput(prev =>'), '草稿填进输入框');
});
