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
  // synthesizeVoiceForReply 定义在 ChatScreen（上移至 useChatSend 调用点之前），
  // settle 后的触发顺序在 useChatSend 的 requestReply 里。
  const source = read('src/ChatScreen.js');
  const sendSource = read('src/chat/useChatSend.js');
  assert.match(source, /synthesizeVoiceForReply/, 'ChatScreen 应定义 settle 后的语音形态处理');
  assert.match(source, /displayMode\s*!==\s*'voice-text'\s*&&\s*displayMode\s*!==\s*'voice'/, '仅 text 形态应跳过合成');
  assert.match(source, /isGroupRef\.current\)\s*return/, '群聊暂不做角色语音');
  assert.match(sendSource, /autoBroadcastMessage\(replyText\);\s*\n\s*synthesizeVoiceForReply\(replyParts, replyText\);/, '语音形态处理应在自动播报后触发');
  assert.match(source, /voiceMode:\s*displayMode/, '挂载 audio 时应带上 voiceMode 供渲染层判定');
});

test('MessageBubble 渲染三档语音形态：纯语音隐藏正文、语音+原文追加气泡', () => {
  const source = read('src/chat/MessageBubble.js');
  assert.match(source, /hideAssistantBody\s*=\s*!isUser\s*&&\s*!!message\.audio\s*&&\s*message\.voiceMode\s*===\s*'voice'/, '纯语音判定应基于 voiceMode');
  assert.match(source, /hideAssistantBody \? \(\s*\n\s*<VoiceBubble message=\{message\} isUser=\{false\} \/\>/, '纯语音应只渲染语音气泡');
  assert.match(source, /\{showRoleVoice \? <VoiceBubble message=\{message\} isUser=\{false\} \/> : null\}/, '语音+原文应在正文后追加气泡');
  // 追加气泡必须排除纯语音，否则 hideAssistantBody 与 showRoleVoice 同时为真，同一条语音渲染两个气泡
  assert.match(source, /showRoleVoice\s*=\s*!isUser\s*&&\s*!!message\.audio\s*&&\s*message\.kind\s*!==\s*'voice'\s*&&\s*!hideAssistantBody/, '追加气泡应排除纯语音形态');
});

test('CharacterEditForm 提供三档语音形态选择并随保存写回', () => {
  const source = read('src/CharacterEditForm.js');
  assert.match(source, /仅文字/, '应提供仅文字选项');
  assert.match(source, /语音 \+ 原文/, '应提供语音+原文选项');
  assert.match(source, /纯语音/, '应提供纯语音选项');
  assert.match(source, /patch\('voiceDisplay', option\.value\)/, '选择应写回表单');
  assert.match(source, /voiceDisplay:\s*\['text', 'voice-text', 'voice'\]\.includes\(draft\.voiceDisplay\)/, '保存应规范化 voiceDisplay');
});

test('CharacterScreen 主角色编辑页同样提供并保存语音形态', () => {
  const source = read('src/CharacterScreen.js');
  assert.match(source, /const \[voiceDisplay, setVoiceDisplay\] = useState\('text'\)/);
  assert.match(source, /voiceDisplay,\s*\n\s*\}\), \[/, '表单签名应包含 voiceDisplay');
  assert.match(source, /voiceDisplay: \['text', 'voice-text', 'voice'\]\.includes\(voiceDisplay\)/, '保存应写回 voiceDisplay');
  assert.match(source, /语音形态/);
  assert.match(source, /纯语音/);
});

test('模型能力弹窗（按模型一份）提供语音识别开关并写入该模型条目', () => {
  const source = read('src/SettingsScreen.js');
  assert.match(source, /支持语音识别/, '能力弹窗应有语音识别开关');
  assert.match(source, /supportsAudio: capabilityDraft\.supportsAudio === true/, '确认时按草稿写条目');
  assert.match(source, /supportsAudio: caps\.supportsAudio/, '打开弹窗时按该模型的现存条目回填');
  assert.match(source, /modelCapabilities: \{ \.\.\.\(selected\.modelCapabilities \|\| \{\}\), \[name\]: entry \}/, '写入 modelCapabilities[模型名]');
  assert.match(source, /supportsAudio: value,/, '开关切换应更新 draft');
});

test('语音兜底接线：supportsAudio 时转写失败按 input_audio 直发，失败反馈可见', () => {
  // 发送侧已外提 useChatSend；转写侧仍在 ChatScreen
  const sendSource = read('src/chat/useChatSend.js');
  const chatSource = read('src/ChatScreen.js');
  assert.match(sendSource, /audioInputEnabled = caps\.supportsAudio === true/, '发送时按当前模型能力读取 supportsAudio');
  assert.match(sendSource, /capabilitiesForModel\(current, current \? getActiveModel\(current\) : ''\)/, '能力按模型解析');
  assert.match(sendSource, /FileSystem\.readAsStringAsync\(voice\.uri, \{\s*\n\s*encoding: FileSystem\.EncodingType\.Base64,/, '兜底应读音频为 base64');
  assert.match(sendSource, /voiceAudio,\s*\n\s*expectedConfigId,/, '兜底音频应随请求 payload 传递');
  assert.match(sendSource, /voiceAudio,\s*\n\s*\}\);/, 'requestReply 应把兜底音频传给 buildRequestMessages');
  assert.match(chatSource, /voice-transcribe/, '转写失败应记录诊断日志');
  assert.match(chatSource, /语音转写失败/, '网络类转写失败应有可见提示');
  assert.match(chatSource, /未配置语音转写/, '无转写来源时应有补配引导');
  const pipelineSource = read('src/prompt/chatPipeline.js');
  assert.match(pipelineSource, /type: 'input_audio', input_audio: \{ data: voiceBase64, format: voiceFormat \}/, '兜底应按 OpenAI input_audio 格式构造');
});
