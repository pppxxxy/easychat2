// 桌面外壳结构守卫（S17）：语音播报链路。
//
// 手机有 expo-speech（系统 TTS）+ VoiceSettingsModal 的「自动播报」开关。桌面此前
// 把 speech 写成 unsupported 占位，理由「不可移植」现已过期——渲染进程就是 Chromium，
// speechSynthesis 是标准能力，Windows 上走 SAPI。
//
// 本守卫只钉「接得上 + 复用共享层判定」：真正的播报语义（何时自动播、失败文案、
// 角色专属音色解析）全在共享层 useChatTts / tts/index，由单测与合成测试覆盖。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, '..');
const read = (...parts) => readFileSync(path.join(DESKTOP, ...parts), 'utf8');

const SPEECH = read('src', 'platform', 'speech.js');
const CAPS = read('src', 'platform', 'capabilities.js');
const HOOK = read('src', 'provider', 'useDesktopChat.js');
const PANE = read('src', 'provider', 'ChatPane.jsx');
const MENU = read('src', 'chat', 'ChatMoreMenu.jsx');
const ACTIONS = read('src', 'render', 'MessageActionsMenu.jsx');
const POLYFILLS = read('src', 'polyfills.js');

test('能力位：voicePlayback 已开，录音仍明确不可用', () => {
  assert.match(CAPS, /voicePlayback:\s*true/, '语音播报能力位应为 true');
  // 录音需要麦克风采集 + 原生录音 API，Electron 渲染层没有 expo-av 等价物。
  assert.match(CAPS, /voiceRecording:\s*false/, '录音能力位不得被顺手打开');
});

test('speech.js 是 Web Speech 实现，不是 unsupported 占位', () => {
  assert.ok(!/unsupported/.test(SPEECH) || !/export default unsupported/.test(SPEECH), '仍是 unsupported 占位');
  assert.ok(SPEECH.includes('speechSynthesis'), '未使用 speechSynthesis');
  assert.ok(SPEECH.includes('SpeechSynthesisUtterance'), '未构造 utterance');
  // 三处平台差异必须显式处理（缺任一条都会表现为「偶发没声音」）。
  assert.ok(SPEECH.includes('voiceschanged'), '缺 voices 异步就绪处理');
  assert.ok(/Math\.min\(10, Math\.max\(0\.1/.test(SPEECH), 'rate 必须夹 0.1..10');
  assert.ok(/entry\.onDone\(\)/.test(SPEECH), 'stop() 必须主动收尾（cancel 不触发 onend）');
});

test('共享层的惰性 require 能解析到 speech（否则播报静默失效）', () => {
  // src/tts/index.js 用 require('expo-speech') 取模块，ESM 渲染进程没有 require。
  assert.match(POLYFILLS, /'expo-speech':\s*speech/, 'require 白名单缺 expo-speech 映射');
});

test('聊天页复用共享 useChatTts，自动播报接进发送链路', () => {
  assert.ok(HOOK.includes('useChatTts'), '未复用共享 TTS hook');
  // autoBroadcastMessage 必须真的传给共享发送链路（useChatSend），而不是只挂在菜单上。
  assert.ok(/autoBroadcastMessage/.test(HOOK), '缺 autoBroadcastMessage');
  assert.ok(/ttsSettings/.test(HOOK) && /toggleBroadcast/.test(HOOK) && /broadcastMessage/.test(HOOK),
    'tts 的三个入口未暴露给界面');
  assert.ok(PANE.includes('autoBroadcast'), '聊天页未接自动播报开关');
  assert.ok(PANE.includes('onToggleAutoBroadcast'), '聊天页缺开关回调');
});

test('自动播报开关按目标值收敛（共享 toggle 是自取反、无参的）', () => {
  assert.ok(/autoBroadcast-\s*'|'auto-broadcast'/.test(MENU), '更多菜单缺自动播报项');
  // 传 value 进去会被静默忽略——必须自己比对当前值，语义才是真的受控。
  assert.ok(/if \(!!value === current\) return/.test(PANE), '开关未按目标值收敛，value 被丢弃');
});

test('单条消息可手动播报，且只对助手消息露出', () => {
  assert.ok(/chat\.bubble\.broadcast/.test(ACTIONS), '消息操作缺播报入口');
  assert.ok(/!isUser && onBroadcast/.test(ACTIONS), '播报入口应只对助手消息出现');
  assert.ok(/onBroadcast/.test(PANE), '聊天页未把播报回调传给消息操作');
});