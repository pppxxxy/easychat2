// 桌面外壳结构守卫（S12）：新建会话必须先选开场白，否则发不出消息。
//
// 这是一条**真故障的回归**，不是风格约束：
//   共享层 useChatSend 里有硬闸 `if (!isGroup && !greetingReady) return false;`，
//   而 greetingReady 只在两种情况下为 true —— 会话已有消息，或 greetingSelected=true。
//   桌面「+」此前直接 startNewSession(characterId) 不带 opening，
//   startNewSession 就把 greetingSelected 写成 false（见 storage/sessionList/mutations.js
//   的 `created.greetingSelected = opening !== null && opening !== undefined`）。
//   于是新会话**发不出任何消息，而且没有任何提示**（false 返回值被宿主忽略）。
//
// 手机版没有这个问题：它走「⋯ → 新对话」→ openGreetingPicker → confirmGreeting，
// 由后者把 firstMes 写回角色卡并以该开场白建会话（opening 非 null）。
// 本文件钉住桌面补齐后的同一条链路。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, '..');
const ROOT = path.resolve(DESKTOP, '..');
const read = (...parts) => readFileSync(path.join(...parts), 'utf8');

const APP = read(DESKTOP, 'src', 'provider', 'DesktopApp.jsx');
const PANE = read(DESKTOP, 'src', 'provider', 'ChatPane.jsx');
const CHAT = read(DESKTOP, 'src', 'provider', 'useDesktopChat.js');
const GREETING_HOOK = read(DESKTOP, 'src', 'chat', 'useDesktopGreeting.js');
const MOBILE_SEND = read(ROOT, 'src', 'chat', 'useChatSend.js');
const MOBILE_SCREEN = read(ROOT, 'src', 'ChatScreen.js');
const MOBILE_SWITCH = read(ROOT, 'src', 'chat', 'useSessionSwitch.js');
const MOBILE_MUTATIONS = read(ROOT, 'src', 'storage', 'sessionList', 'mutations.js');

test('共享层的发送闸门仍然存在（本组修复的前提，不是可选项）', () => {
  // 若哪天这条闸门被移除，下面的结构性约束就该重新评估——先把前提钉住。
  assert.ok(
    /if \(!isGroupRef\.current && !greetingReady\) return false;/.test(MOBILE_SEND),
    'useChatSend 的 greetingReady 闸门不存在了，请复核开场白流程是否仍必要'
  );
  // greetingSelected 的判据：opening 非 null 才算选过。
  assert.ok(
    /created\.greetingSelected = opening !== null && opening !== undefined;/.test(MOBILE_MUTATIONS),
    'startNewSession 的 greetingSelected 判据变了，newSessionOpening 恒返回对象的前提需复核'
  );
});

test('手机版对照：新建对话先走开场白选择器', () => {
  // 手机 onNewChat 的单聊分支结尾是 openGreetingPicker('new')（在 useSessionSwitch.js）；
  // 发送前也有同样的拦截（在 ChatScreen.js）。
  assert.ok(MOBILE_SWITCH.includes("openGreetingPicker('new')"), '手机新建对话未走开场白选择器');
  assert.ok(
    MOBILE_SCREEN.includes("openGreetingPicker(activeSessionId ? 'reselect' : 'new')"),
    '手机发送前缺开场白拦截'
  );
});

test('桌面「+」不再直接 startNewSession，而是先请求开场白选择器', () => {
  // 直接建会话会让 greetingSelected=false = 发不出消息。
  assert.equal(
    /startNewSession\(activeId\)/.test(APP),
    false,
    '顶栏「+」不得绕过开场白直接建会话'
  );
  assert.ok(APP.includes('requestGreetingPicker'), '「+」未请求开场白选择器');
  assert.ok(APP.includes("from '../chat/greetingRequest.js'"), '未接请求通道');
  // 必须先切到聊天页，否则选择器所在的 ChatPane 不挂载。
  const onClick = APP.slice(APP.indexOf('requestGreetingPicker'));
  assert.ok(onClick.length > 0, '找不到请求调用');
  assert.ok(
    APP.indexOf("setView('chat')") < APP.indexOf('requestGreetingPicker()'),
    '应先切到聊天页再发请求（否则 ChatPane 未挂载，请求无人消费）'
  );
});

test('桌面发送前也有开场白拦截（与手机同一分支语义）', () => {
  assert.ok(PANE.includes('chat.greetingReady'), '聊天面板未读取 greetingReady');
  assert.ok(PANE.includes('greeting.open('), '发送前未打开开场白选择器');
  // 拦截必须在真正 sendText 之前。
  assert.ok(
    PANE.indexOf('greeting.open(') < PANE.indexOf('const result = sendText('),
    '开场白拦截必须发生在 sendText 之前'
  );
});

test('开场白选择器已挂载，且两种用途都有落点', () => {
  assert.ok(PANE.includes("import GreetingPicker from '../chat/GreetingPicker.jsx'"), '未引入选择器');
  assert.ok(PANE.includes('<GreetingPicker'), '选择器未渲染');
  // 新建与重选两条路径：新建写回角色卡 + startNewSession；重选只换当前会话的消息。
  assert.ok(GREETING_HOOK.includes("flow.purpose === 'new'"), '缺少新建分支');
  assert.ok(GREETING_HOOK.includes('startNewSession(characterId, newSessionOpening(selection))'), '新建分支未带 opening');
  assert.ok(GREETING_HOOK.includes('setSessionGreetingSelected'), '重选分支未置位 greetingSelected');
  assert.ok(GREETING_HOOK.includes('applyGreetingToMessages'), '重选分支未替换开场白消息');
});

test('停止生成按钮已接上（生成中发送键变停止键）', () => {
  assert.ok(CHAT.includes('const stop = useCallback'), 'useDesktopChat 未暴露 stop');
  assert.ok(CHAT.includes('abortRef.current.abort()'), 'stop 未走共享 abortRef');
  assert.ok(PANE.includes('chat.stop'), '聊天面板未使用 stop');
  // 必须与发送键同位（同一个按钮的两种态），而不是另加一个只在特定时刻出现的按钮。
  assert.ok(PANE.includes('onClick={isSending ? chat.stop : submit}'), '停止未与发送键同位');
});

test('「+」的请求在 ChatPane 未挂载期间也不丢', () => {
  // 顶栏先 setView('chat') 再发请求，而本次渲染可能尚未提交 —— 挂载时必须回读一次。
  assert.ok(PANE.includes('consumeGreetingPicker'), 'ChatPane 未消费请求');
  assert.ok(PANE.includes('subscribeGreetingRequest'), 'ChatPane 未订阅请求');
  // 挂载 effect 里要先直接消费一次（覆盖「请求早于挂载」的窗口）。
  const effectBody = PANE.slice(PANE.indexOf('const openPending = () =>'));
  assert.ok(effectBody.includes('openPending();'), '挂载时未先消费一次待处理请求');
});