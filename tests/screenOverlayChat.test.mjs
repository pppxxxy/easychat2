// SW3：悬浮窗 mini 聊天（原生只做嘴和眼，LLM/工具/确认全在 JS 侧）。
//
// 本机没有 Android SDK / Java（仓库 AGENTS.md 已记载这一约束），Kotlin **无法编译验证**——
// 因此分两层测：
//   ① 纯逻辑层（overlayEvents 的解析/构造）：真行为测试；
//   ② Kotlin 静态校验：钉住结构契约（事件名、scope 常量、键盘 flag 切换、消息上限），
//      与 tests/screenOverlayPlugin.test.mjs / kotlinSources.test.mjs 同款做法。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  OVERLAY_CHAT_SCOPES,
  OVERLAY_EVENT_CHAT_SEND,
  buildChatPushPayload,
  parseChatConfirmAnswers,
  parseChatSendEvent,
} from '../src/screenWatch/overlayEvents.js';

const read = rel => fs.readFileSync(path.resolve(rel), 'utf8');

// —— ① 纯逻辑层 ——

test('parseChatSendEvent：空文本挡掉，scope 非法回落 chat', () => {
  assert.deepEqual(parseChatSendEvent({ text: ' 看下这个 ', scope: 'workspace' }), {
    text: '看下这个', scope: 'workspace',
  });
  assert.deepEqual(parseChatSendEvent({ text: 'hi' }), { text: 'hi', scope: 'chat' }, '缺 scope 回落聊天');
  for (const bad of [null, undefined, {}, { text: '   ' }, { text: 123 && '' }]) {
    assert.equal(parseChatSendEvent(bad), null, `${JSON.stringify(bad)} 应视为无效事件`);
  }
  for (const bad of ['WORKSPACE', 'other', 0, {}]) {
    assert.equal(parseChatSendEvent({ text: 'x', scope: bad }).scope, 'chat');
  }
  assert.deepEqual([...OVERLAY_CHAT_SCOPES], ['chat', 'workspace']);
});

test('buildChatPushPayload：role 归一 + 题卡只带 id/text（原生只画得出这两样）', () => {
  assert.deepEqual(buildChatPushPayload({ role: 'user', text: 'hi' }), { role: 'user', text: 'hi' });
  assert.deepEqual(buildChatPushPayload({ role: 'nope', text: 'x' }), { role: 'assistant', text: 'x' });
  const withConfirm = buildChatPushPayload({
    text: '要确认两件事',
    confirm: {
      questions: [
        { id: 'q1', text: '由当前角色来吗', other: { type: 'list', source: 'characters' } },
        { id: 'q2', text: '要润色吗' },
        { id: '', text: '无 id 丢弃' },
        { id: 'q3', text: '' },
      ],
    },
  });
  assert.equal(withConfirm.confirm.questions.length, 2, '无 id/无 text 的题丢弃');
  assert.deepEqual(withConfirm.confirm.questions[0], { id: 'q1', text: '由当前角色来吗' },
    'other 细节不下发原生（原生只画是/否/其他三按钮）');
  assert.equal(buildChatPushPayload({}).confirm, undefined, '无题卡时不造空对象');
  assert.equal(buildChatPushPayload({ confirm: { questions: [] } }).confirm, undefined);
});

test('parseChatConfirmAnswers：合法答案透传，非法项丢弃，空结果返回 null', () => {
  assert.deepEqual(parseChatConfirmAnswers({
    answers: [
      { id: 'q1', answer: 'yes' },
      { id: 'q2', answer: 'custom', custom: ' 橘鸦 ' },
    ],
  }), [{ id: 'q1', answer: 'yes' }, { id: 'q2', answer: 'custom', custom: '橘鸦' }]);

  // 非法项：缺 id / 非法 answer / custom 空文本 → 全部丢弃
  assert.equal(parseChatConfirmAnswers({
    answers: [{ answer: 'yes' }, { id: 'q2', answer: 'maybe' }, { id: 'q3', answer: 'custom', custom: '  ' }],
  }), null);
  assert.equal(parseChatConfirmAnswers(null), null);
  assert.equal(parseChatConfirmAnswers({ answers: [] }), null);
});

// —— ② Kotlin 静态校验（本机无法编译，按仓库既有做法钉结构契约）——

test('Kotlin：事件名与 JS 侧常量逐字一致（改一边会静默失联）', () => {
  const service = read('plugins/screenOverlay/android/OverlayService.kt');
  assert.ok(service.includes(`const val EVENT_CHAT_SEND = "${OVERLAY_EVENT_CHAT_SEND}"`),
    `原生 EVENT_CHAT_SEND 必须等于 ${OVERLAY_EVENT_CHAT_SEND}`);
  assert.ok(service.includes('const val SCOPE_CHAT = "chat"'), 'scope 常量 chat');
  assert.ok(service.includes('const val SCOPE_WORKSPACE = "workspace"'), 'scope 常量 workspace');
  for (const scope of OVERLAY_CHAT_SCOPES) {
    assert.ok(service.includes(`"${scope}"`), `原生应认得 scope ${scope}`);
  }
});

test('Kotlin：mini 聊天的三件套齐备（消息区 / 输入框 / scope 切换）', () => {
  const service = read('plugins/screenOverlay/android/OverlayService.kt');
  assert.ok(service.includes('private var chatMessages: ScrollView?'), '消息区是 ScrollView');
  assert.ok(service.includes('private var chatInput: EditText?'), '输入框是 EditText');
  assert.ok(service.includes('private fun toggleChatScope()'), 'scope 切换按钮存在');
  assert.ok(service.includes('private fun appendChatMessage('), '消息追加实现存在');
  assert.ok(service.includes('fun pushChatMessage('), 'JS → 原生推送入口存在');
  // 上限裁剪：长会话不得把悬浮窗撑爆
  assert.ok(service.includes('CHAT_MESSAGE_MAX'), '消息条数上限常量');
  assert.ok(/while \(container\.childCount > CHAT_MESSAGE_MAX\)/.test(service), '超出上限时裁剪最旧消息');
  // scope 切换**不清消息**（用户要求切种类保留上下文）
  assert.match(service, /private fun toggleChatScope\(\)[\s\S]{0,400}?scopeButton\?\.text = scopeLabel\(\)/,
    '切换只改按钮文案与 scope');
  assert.equal(/private fun toggleChatScope\(\)[\s\S]{0,400}?removeAllViews/.test(service), false,
    '切换 scope 不得清空消息');
});

test('Kotlin：键盘 flag 动态切换（悬浮窗弹输入法的关键坑）', () => {
  const service = read('plugins/screenOverlay/android/OverlayService.kt');
  assert.ok(service.includes('private fun setFocusableForInput('), 'flag 切换函数存在');
  // 点输入框去掉 NOT_FOCUSABLE（否则输入法弹不出来）
  assert.match(service, /FLAG_NOT_FOCUSABLE\.inv\(\)/, '聚焦时必须去掉 NOT_FOCUSABLE');
  assert.ok(service.includes('FLAG_ALT_FOCUSABLE_IM'), 'ROM 兼容备选 flag');
  assert.ok(service.includes('setOnFocusChangeListener'), '输入框焦点变化触发 flag 切换');
  // 键盘遮挡：面板上移
  assert.ok(service.includes('fun applyImeInset('), '键盘 inset 处理存在');
  assert.ok(service.includes('private var baseY = 0'), '记录基准 y（收起键盘后复位）');
});

test('Kotlin：架构边界——原生不碰业务逻辑（只 emit 事件，不发请求）', () => {
  const service = read('plugins/screenOverlay/android/OverlayService.kt');
  // 原生只把用户输入交给 JS；LLM/工具/确认都在 JS 侧
  assert.match(service, /ScreenOverlayModule\.emit\(EVENT_CHAT_SEND/, '用户输入经事件交给 JS');
  for (const forbidden of ['sendChatMessage', 'runAgentTurn', 'confirm_flow', 'fetch(']) {
    assert.equal(service.includes(forbidden), false, `原生不得直接做业务（发现 ${forbidden}）`);
  }
});

test('Kotlin：模块方法齐备且失败不崩（promise.reject 有 catch）', () => {
  const module_ = read('plugins/screenOverlay/android/ScreenOverlayModule.kt');
  assert.ok(module_.includes('fun pushChatMessage('), 'pushChatMessage 已注册');
  assert.ok(module_.includes('fun setImeInset('), 'setImeInset 已注册');
  assert.match(module_, /fun pushChatMessage\([\s\S]{0,400}?catch \(e: Exception\)/, '推送失败要 reject 而非崩');
  assert.match(module_, /fun setImeInset\([\s\S]{0,400}?catch \(e: Exception\)/, 'inset 失败要 reject 而非崩');
  assert.ok(module_.includes('OverlayService.instance?.pushChatMessage(role, text)'), '经单例转发到服务');
});

test('JS 桥：新方法在旧构建上安全降级（不支持的模块 → false，不抛）', async () => {
  const overlay = read('src/screenWatch/overlay.js');
  assert.ok(overlay.includes('export async function pushOverlayChatMessage('), '推送封装存在');
  assert.ok(overlay.includes('export async function setOverlayImeInset('), 'inset 封装存在');
  assert.ok(overlay.includes('export function addChatSendListener('), '事件订阅存在');
  // 降级纪律：先查方法存在性再调（老构建没有这些方法）
  assert.match(overlay, /typeof module\.pushChatMessage !== 'function'[\s\S]{0,80}?return false/,
    '方法缺失时返回 false');
  assert.match(overlay, /typeof module\.setImeInset !== 'function'[\s\S]{0,80}?return false/,
    '方法缺失时返回 false');
});
