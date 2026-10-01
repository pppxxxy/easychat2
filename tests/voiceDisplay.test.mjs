// 语音消息批次 2（D+E）源码断言：角色按角色卡回语音的接线完整性。
// UI 层（RN hooks/JSX）无法在纯 Node 里执行，按既有惯例用源码断言锁定关键链路。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = relPath => fs.readFileSync(path.resolve(relPath), 'utf8');

test('useChatTts 提供角色语音合成：落盘到 voice/ 目录并走密钥登记与回收保护', () => {
  const source = read('src/chat/useChatTts.js');
  assert.match(source, /synthesizeVoice\s*=/, 'useChatTts 应定义 synthesizeVoice');
  assert.match(source, /await\s+synthesize\(\{/, '合成应调用 tts 引擎的 synthesize');
  assert.match(source, /isSystemProvider\(provider\)/, '系统引擎无法产文件，应明确排除');
  assert.match(source, /documentDirectory\}voice\//, '音频应落盘到 voice/ 目录');
  assert.match(source, /EncodingType\.Base64/, 'base64 音频应按 base64 编码写文件');
  assert.match(source, /markMediaWrite\(uri\)/, '刚写的音频应登记回收保护');
  assert.match(source, /return null;/, '合成失败应返回 null 让调用方降级');
});

test('ChatScreen 按 voiceDisplay 在回复 settle 后合成并挂载 audio', () => {
  const source = read('src/ChatScreen.js');
  assert.match(source, /synthesizeVoiceForReply/, 'ChatScreen 应定义 settle 后的语音形态处理');
  assert.match(source, /displayMode\s*!==\s*'voice-text'\s*&&\s*displayMode\s*!==\s*'voice'/, '仅 text 形态应跳过合成');
  assert.match(source, /isGroupRef\.current\)\s*return/, '群聊暂不做角色语音');
  assert.match(source, /autoBroadcastMessage\(replyText\);\s*\n\s*synthesizeVoiceForReply\(replyParts, replyText\);/, '语音形态处理应在自动播报后触发');
  assert.match(source, /voiceMode:\s*displayMode/, '挂载 audio 时应带上 voiceMode 供渲染层判定');
});

test('MessageBubble 渲染三档语音形态：纯语音隐藏正文、语音+原文追加气泡', () => {
  const source = read('src/chat/MessageBubble.js');
  assert.match(source, /hideAssistantBody\s*=\s*!isUser\s*&&\s*!!message\.audio\s*&&\s*message\.voiceMode\s*===\s*'voice'/, '纯语音判定应基于 voiceMode');
  assert.match(source, /hideAssistantBody \? \(\s*\n\s*<VoiceBubble message=\{message\} isUser=\{false\} \/\>/, '纯语音应只渲染语音气泡');
  assert.match(source, /\{showRoleVoice \? <VoiceBubble message=\{message\} isUser=\{false\} \/> : null\}/, '语音+原文应在正文后追加气泡');
});

test('CharacterEditForm 提供三档语音形态选择并随保存写回', () => {
  const source = read('src/CharacterEditForm.js');
  assert.match(source, /仅文字/, '应提供仅文字选项');
  assert.match(source, /语音 \+ 原文/, '应提供语音+原文选项');
  assert.match(source, /纯语音/, '应提供纯语音选项');
  assert.match(source, /patch\('voiceDisplay', option\.value\)/, '选择应写回表单');
  assert.match(source, /voiceDisplay:\s*\['text', 'voice-text', 'voice'\]\.includes\(draft\.voiceDisplay\)/, '保存应规范化 voiceDisplay');
});

test('SettingsScreen 能力弹窗提供语音识别开关并写入配置', () => {
  const source = read('src/SettingsScreen.js');
  assert.match(source, /支持语音识别/, '能力弹窗应有语音识别开关');
  assert.match(source, /supportsAudio: caps\.supportsAudio === true/, '保存时应写入 supportsAudio');
  assert.match(source, /supportsAudio: selected\.supportsAudio === true/, '打开弹窗时应回填 supportsAudio');
  assert.match(source, /supportsAudio: value,\s*\n\s*\}\)\)\}/, '开关切换应更新 draft');
});
