// 设置页第五轮审查（2026-10-05）落地项的回归固定（源码断言，先例：chatScreenSplit.test.mjs）。
//
// 审查报告跑在旧 main 上，本批落地前已在当前树逐条核实：三条驳回（removePersona 已有
// 确认弹窗；切换配置是「静默落盘」而非丢失；三个弹层是居中对话框而非贴底 sheet，fade
// 是对的）均不动代码；本文件钉住真正落地的四件事。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { zhCN } from '../src/i18n/locales/zh-CN.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = rel => readFileSync(path.join(HERE, '..', rel), 'utf8');

// 设置页卡片内容已拆到 settings/sections/*；这些源码断言横跨卡片与其状态宿主，
// 合并读取以免拆卡后断言错位（行为不变，只换文件）。
const SECTION_FILES = [
  'ApiSection.js',
  'PersonaSection.js',
  'AppearanceSection.js',
  'ExperienceSection.js',
  'ExtensionsSection.js',
  'VectorSection.js',
  'WorkspaceSection.js',
  'GithubSection.js',
  'AboutSection.js',
];
const SETTINGS = [
  read('src/SettingsScreen.js'),
  ...SECTION_FILES.map(name => read(`src/settings/sections/${name}`)),
  read('src/settings/SecretTextField.js'),
].join('\n');
const STYLES = read('src/settings/settingsStyles.js');
const PROFILE = read('src/settings/useUserProfile.js');
const PKG = JSON.parse(read('package.json'));

test('模型能力按「模型」一份：添加即弹确认、芯片可编辑、写 modelCapabilities', () => {
  // 能力弹层按模型打开（草稿从 rawCapabilityForModel 起稿，记住当前模型名）。
  // 必须是 raw 版本：回填要带出用户填过的高级项，「自定义参数」关掉再打开时值还在。
  assert.ok(SETTINGS.includes('const openCapabilityEditor = modelName => {'), '按模型打开能力弹层');
  assert.ok(SETTINGS.includes('const caps = rawCapabilityForModel(selected, name);'),
    '草稿按该模型的现存条目起稿（原始值，不受自定义开关回落影响）');
  assert.ok(SETTINGS.includes('setCapabilityEditorModel(name);'), '记住正在编辑的模型名');
  // 两条添加路径都要顺手弹确认（手动输入 + 可用模型列表）
  assert.equal((SETTINGS.match(/openCapabilityEditor\(model\);/g) || []).length >= 3, true,
    'addModel（新增/已存在）与 applyModel 都要打开能力确认');
  assert.ok(SETTINGS.includes("// 从「可用模型」列表添加/选中后，顺手确认这个模型的能力。"), 'applyModel 注释接线');
  // 确认写回的是该模型的条目（不是配置级字段）
  assert.ok(SETTINGS.includes('modelCapabilities: { ...(selected.modelCapabilities || {}), [name]: entry }'),
    '确认写回 modelCapabilities[模型名]');
  assert.ok(SETTINGS.includes('normalizeCapabilityEntry({'), '写回前归一（默认字段名/格式）');
  // 保存链路不再弹「配置级」能力弹层（原 performSave(caps) 已拆掉）
  assert.equal(SETTINGS.includes('performSave(capabilityDraft)'), false, '保存不再携带配置级能力草稿');
  assert.equal(SETTINGS.includes('await performSave();'), true, '保存直接落盘（能力已随草稿保存）');
  assert.equal(/performSave = async caps/.test(SETTINGS), false, 'performSave 不再接收能力参数');
  // 模型芯片带能力编辑入口，未确认（无条目）时图标置灰提示
  assert.ok(SETTINGS.includes('onPress={() => openCapabilityEditor(model)}'), '芯片上的滑杆图标');
  assert.ok(SETTINGS.includes("(active.modelCapabilities && active.modelCapabilities[model])"), '未确认模型有视觉区分');
});

test('能力弹层：自定义参数总开关 + 上下文/输出长度同框 + 思考参数折叠选择器', () => {
  // 总开关默认关闭；关闭时不渲染高级参数区
  assert.ok(/customParams:\s*false/.test(SETTINGS), '草稿默认关闭自定义参数');
  assert.ok(SETTINGS.includes("t('settings.capability.customParams')"), '有总开关行');
  assert.ok(SETTINGS.includes('capabilityDraft.customParams === true ? ('), '关闭时不渲染高级参数');
  assert.ok(SETTINGS.includes('customParams: capabilityDraft.customParams === true,'), '确认写回开关');

  // 上下文窗口 + 输出长度：同一参数框，默认值 200000 / 32000
  assert.ok(SETTINGS.includes("t('settings.capability.contextWindow')") && SETTINGS.includes("t('settings.capability.outputLength')"), '两个字段都在');
  assert.ok(SETTINGS.includes("t('settings.capability.contextWindowPlaceholder')"), '上下文默认值提示');
  assert.ok(SETTINGS.includes("t('settings.capability.outputLengthPlaceholder')"), '输出长度默认值提示');
  assert.ok(SETTINGS.includes('capabilityDraft.maxOutput'), '输出长度接入草稿');
  assert.ok(SETTINGS.includes('maxOutput: Math.max(0, Math.floor(Number(capabilityDraft.maxOutput)) || 0)'),
    '确认写回输出长度');
  assert.ok(SETTINGS.includes('styles.paramBox') && SETTINGS.includes('styles.paramFieldLast'),
    '两个字段收进同一个框（末行去分隔线）');
  assert.ok(SETTINGS.includes('styles.paramHint'), '框内保留「用于压缩」的说明');

  // 思考参数：折叠 + 点击选择（不再直接摊开输入框 + 格式芯片）
  assert.ok(SETTINGS.includes('thinkingPresetOpen') && SETTINGS.includes('setThinkingPresetOpen(open => !open)'),
    '折叠标题可点击展开');
  assert.ok(SETTINGS.includes('THINKING_PRESETS.map'), '展开后渲染预设列表');
  assert.ok(SETTINGS.includes('matchedThinkingPreset'), '标题显示当前命中的预设');
  assert.ok(SETTINGS.includes('{!matchedThinkingPreset ? ('), '仅「自定义」时显示手输框');
  assert.ok(SETTINGS.includes('OpenAI GPT-5 系'), '预设带适用模型说明：OpenAI（2026-10 更新后锚点）');
  assert.ok(SETTINGS.includes('Claude Opus 5'), '预设带适用模型说明：Claude（2026-10 更新后锚点）');
  assert.ok(SETTINGS.includes('通义千问 Qwen3'), '预设带适用模型说明：Qwen');
  assert.ok(SETTINGS.includes('rawCapabilityForModel'), '回填走原始值（关掉开关也记得上次填的）');

  // 弹层：往上靠 + 内容可滚动（变长后底部按钮不被顶出屏幕）
  assert.ok(SETTINGS.includes('styles.capabilityBackdrop') && SETTINGS.includes('styles.capabilitySheet'),
    '弹层专属容器样式');
  const modalStart = SETTINGS.indexOf("t('settings.capability.title')");
  const modalEnd = SETTINGS.indexOf("t('settings.about.disclaimer')", modalStart);
  assert.ok(modalStart > 0 && modalEnd > modalStart, '必须能截出能力弹层渲染区');
  assert.ok(SETTINGS.slice(modalStart, modalEnd).includes('</ScrollView>'), '能力弹层内容区可滚动');
  assert.ok(STYLES.includes("capabilityBackdrop: { justifyContent: 'flex-start'"), '从顶部起排（往上挪）');
  assert.ok(STYLES.includes('presetItem:') && STYLES.includes('collapseHeader:'), '选择器样式齐备');
});

test('API 配置：切走前确认未保存的修改，基线在加载/落盘后刷新', () => {
  // 基线判定函数存在且两处刷新（初始加载 + persist）
  assert.ok(SETTINGS.includes('function snapshotActiveConfig(state)'));
  assert.equal(
    (SETTINGS.match(/apiBaselineRef\.current = snapshotActiveConfig\(/g) || []).length,
    2,
    '初始加载与 persist 都要刷新基线'
  );
  // 切换的两条路（选配置 / 选厂商预设）都必须先过确认
  assert.ok(SETTINGS.includes('const confirmDiscardDirtyApi = () => new Promise(resolve => {'));
  assert.equal((SETTINGS.match(/await confirmDiscardDirtyApi\(\)/g) || []).length, 2);
  assert.ok(SETTINGS.includes('const selectConfig = async id => {'));
  assert.ok(SETTINGS.includes('const applyVendorPreset = async preset => {'));
  // 确认弹窗必须提供「继续编辑 / 放弃并切换」两支，且放弃时还原基线快照
  assert.ok(SETTINGS.includes("t('settings.api.dirty.keep')"), '应引用继续编辑按钮的 i18n 键');
  assert.equal(zhCN['settings.api.dirty.keep'], '继续编辑', '语言包中文值正确');
  assert.ok(SETTINGS.includes("t('settings.api.dirty.discard')"), '应引用放弃并切换按钮的 i18n 键');
  assert.equal(zhCN['settings.api.dirty.discard'], '放弃并切换', '语言包中文值正确');
  assert.ok(SETTINGS.includes('JSON.parse(apiBaselineRef.current)'));
});

test('密钥输入：四处 secureTextEntry 全部走带显隐切换的 SecretTextField', () => {
  assert.equal((SETTINGS.match(/<SecretTextField/g) || []).length, 4, 'API/生图/向量/GitHub 令牌四处密钥');
  // 组件内部持有显隐状态；明文不再由调用点写死
  assert.ok(SETTINGS.includes('secureTextEntry={!visible}'));
  assert.equal(SETTINGS.includes('secureTextEntry\n'), false, '不应再有裸 secureTextEntry');
  assert.equal((SETTINGS.match(/accessibilityLabel=\{visible \? t\('settings\.secret\.hide'\) : t\('settings\.secret\.show'\)\}/g) || []).length, 1, '显隐切换可访问名应走 i18n 键');
  assert.equal(zhCN['settings.secret.hide'], '隐藏密钥', '语言包中文值正确');
  assert.equal(zhCN['settings.secret.show'], '显示密钥', '语言包中文值正确');
  assert.ok(STYLES.includes('secretRow:') && STYLES.includes('secretToggle:'));
});

test('关于卡：显示应用版本号（expo-constants，依赖已声明）', () => {
  assert.equal(PKG.dependencies['expo-constants'], '~18.0.14');
  assert.ok(SETTINGS.includes("import Constants from 'expo-constants';"));
  assert.ok(SETTINGS.includes('const APP_VERSION = Constants.expoConfig ? String(Constants.expoConfig.version || \'\') : \'\';'));
  assert.ok(SETTINGS.includes(">{t('settings.about.version')}</Text>"), '应引用当前版本标签的 i18n 键');
  assert.equal(zhCN['settings.about.version'], '当前版本', '语言包中文值正确');
  assert.ok(STYLES.includes('versionText:'));
});

test('删除人设保持有确认弹窗（审查存疑项，核实为已有，钉住防回归）', () => {
  assert.ok(PROFILE.includes("t('settings.profile.alert.delete.title')"), '应引用删除人设标题的 i18n 键');
  assert.equal(zhCN['settings.profile.alert.delete.title'], '删除人设', '语言包中文值正确');
  assert.ok(PROFILE.includes("t('settings.profile.alert.delete.body')"), '应引用删除人设正文的 i18n 键');
  assert.equal(zhCN['settings.profile.alert.delete.body'], '确定删除这个人设吗？', '语言包中文值正确');
  assert.ok(PROFILE.includes("'destructive'"));
});

test('模型列表：检测与按输入搜索共用同一拉取逻辑，且搜索按钮已接线', () => {
  // 拉取逻辑抽成共享函数，检测与搜索都走它（避免两处各写一遍 /models 解析）
  assert.ok(SETTINGS.includes('const fetchProviderModels = async (selected, request, isCurrent) => {'));
  assert.ok(SETTINGS.includes('const beginModelRequest = () => {'));
  assert.ok(SETTINGS.includes('const endModelRequest = () => {'));
  assert.equal((SETTINGS.match(/await fetchProviderModels\(selected, request, isCurrent\)/g) || []).length, 2,
    'detectModels 与 searchModels 各调用一次共享拉取');
  // searchModels：按输入过滤，未匹配给提示，空输入列出全部
  assert.ok(SETTINGS.includes('const searchModels = async () => {'));
  assert.ok(SETTINGS.includes('all.filter(model => model.toLowerCase().includes(query))'));
  assert.ok(SETTINGS.includes("t('settings.api.noMatch.title')"), '应引用未找到匹配模型提示的 i18n 键');
  assert.equal(zhCN['settings.api.noMatch.title'], '未找到匹配的模型', '语言包中文值正确');
  // 搜索按钮在模型输入行内、紧邻「添加」，并带可访问名
  assert.ok(SETTINGS.includes('onPress={searchModels}'));
  assert.ok(SETTINGS.includes("accessibilityLabel={t('settings.api.a11ySearchModels')}"), '搜索按钮可访问名应走 i18n 键');
  assert.equal(zhCN['settings.api.a11ySearchModels'], '按输入内容搜索接口上的模型', '语言包中文值正确');
  assert.ok(STYLES.includes('modelSearchButton:'));
});
