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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = rel => readFileSync(path.join(HERE, '..', rel), 'utf8');

const SETTINGS = read('src/SettingsScreen.js');
const STYLES = read('src/settings/settingsStyles.js');
const PROFILE = read('src/settings/useUserProfile.js');
const PKG = JSON.parse(read('package.json'));

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
  assert.ok(SETTINGS.includes("'继续编辑'"));
  assert.ok(SETTINGS.includes("'放弃并切换'"));
  assert.ok(SETTINGS.includes('JSON.parse(apiBaselineRef.current)'));
});

test('密钥输入：三处 secureTextEntry 全部走带显隐切换的 SecretTextField', () => {
  assert.equal((SETTINGS.match(/<SecretTextField/g) || []).length, 3, 'API/生图/向量三处密钥');
  // 组件内部持有显隐状态；明文不再由调用点写死
  assert.ok(SETTINGS.includes('secureTextEntry={!visible}'));
  assert.equal(SETTINGS.includes('secureTextEntry\n'), false, '不应再有裸 secureTextEntry');
  assert.equal((SETTINGS.match(/accessibilityLabel=\{visible \? '隐藏密钥' : '显示密钥'\}/g) || []).length, 1);
  assert.ok(STYLES.includes('secretRow:') && STYLES.includes('secretToggle:'));
});

test('关于卡：显示应用版本号（expo-constants，依赖已声明）', () => {
  assert.equal(PKG.dependencies['expo-constants'], '~18.0.14');
  assert.ok(SETTINGS.includes("import Constants from 'expo-constants';"));
  assert.ok(SETTINGS.includes('const APP_VERSION = Constants.expoConfig ? String(Constants.expoConfig.version || \'\') : \'\';'));
  assert.ok(SETTINGS.includes('>当前版本</Text>'));
  assert.ok(STYLES.includes('versionText:'));
});

test('删除人设保持有确认弹窗（审查存疑项，核实为已有，钉住防回归）', () => {
  assert.ok(PROFILE.includes("'删除人设'"));
  assert.ok(PROFILE.includes("'确定删除这个人设吗？'"));
  assert.ok(PROFILE.includes("'destructive'"));
});
