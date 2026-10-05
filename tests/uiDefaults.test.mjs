import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 设置页「对话体验」卡内容已拆到 settings/sections/ExperienceSection.js，
// 全宽相关断言横跨卡片与其状态宿主，合并读取。
const SETTINGS_SCREEN_SOURCE = [
  readFileSync(path.join(HERE, '..', 'src', 'SettingsScreen.js'), 'utf8'),
  readFileSync(path.join(HERE, '..', 'src', 'settings', 'sections', 'ExperienceSection.js'), 'utf8'),
].join('\n');
const EXTENSION_SCREEN_SOURCE = readFileSync(path.join(HERE, '..', 'src', 'extension', 'ExtensionHome.js'), 'utf8');
const CHAT_SCREEN_SOURCE = readFileSync(path.join(HERE, '..', 'src', 'ChatScreen.js'), 'utf8');
const VOICE_SETTINGS_SOURCE = readFileSync(path.join(HERE, '..', 'src', 'chat', 'VoiceSettingsModal.js'), 'utf8');

test('全宽对话默认关闭，开启前弹窗提醒滑动风险', () => {
  // 默认值：存储层与 UI 初始 state 均为关闭（fullWidth === true 才开启）
  assert.ok(SETTINGS_SCREEN_SOURCE.includes('fullWidth: false'));
  // 开启时必须弹窗提醒用户「屏幕滑动」风险，确认后才落盘（文案走 i18n）
  assert.ok(SETTINGS_SCREEN_SOURCE.includes("t('settings.experience.fullWidth.body')"));
  // 确认弹窗：取消可退出，开关回弹；确认后才真正开启
  assert.ok(SETTINGS_SCREEN_SOURCE.includes("t('common.cancel')"));
  assert.ok(SETTINGS_SCREEN_SOURCE.includes("t('settings.experience.fullWidth.confirm')"));
  // 关闭路径不需要确认，直接落盘
  assert.ok(SETTINGS_SCREEN_SOURCE.includes("updateChatOption('fullWidth', false)"));
});

test('聊天「更多」菜单含语音入口，弹窗提供全语音开关与转文字设置', () => {
  // 更多菜单新增「语音」项
  assert.ok(CHAT_SCREEN_SOURCE.includes("key: 'voice'"));
  assert.ok(CHAT_SCREEN_SOURCE.includes("label: '语音'"));
  assert.ok(CHAT_SCREEN_SOURCE.includes('setVoiceSettingsOpen(true)'));
  // 弹窗提供全语音模式开关与语音转文字入口
  assert.ok(VOICE_SETTINGS_SOURCE.includes('全语音模式'));
  assert.ok(VOICE_SETTINGS_SOURCE.includes('语音转文字设置'));
  assert.ok(VOICE_SETTINGS_SOURCE.includes('onToggleVoiceMode'));
  assert.ok(VOICE_SETTINGS_SOURCE.includes('onOpenTranscription'));
  // 全语音开关在 voice / text 之间切换当前角色
  assert.ok(CHAT_SCREEN_SOURCE.includes("character.voiceDisplay === 'voice' ? 'text' : 'voice'"));
  // 打开系统「语音转文字」配置面板
  assert.ok(CHAT_SCREEN_SOURCE.includes('<TranscriptionPanel'));
});

test('拓展首页不再有手风琴展开状态（Stack 化后所有入口同行为 navigate）', () => {
  assert.equal(EXTENSION_SCREEN_SOURCE.includes('openSection'), false, '不再有手风琴展开状态');
  assert.equal(EXTENSION_SCREEN_SOURCE.includes('setSegment'), false, '不再有 segment 状态机');
  assert.ok(EXTENSION_SCREEN_SOURCE.includes('navigation.navigate('), '首页统一用 navigate');
});
