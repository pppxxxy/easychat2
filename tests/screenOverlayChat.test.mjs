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
  // 上限裁剪：长会话不得把悬浮窗撑爆。
  // FIX-SW6：裁剪对象从 ScrollView 改成内衬 LinearLayout（ScrollView 只允许一个直接子
  // View，消息必须挂内衬）。断言随实现改名，语义不变。
  assert.ok(service.includes('CHAT_MESSAGE_MAX'), '消息条数上限常量');
  assert.ok(/while \(list\.childCount > CHAT_MESSAGE_MAX\)/.test(service), '超出上限时裁剪最旧消息');
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
  // ⚠️ FLAG_ALT_FOCUSABLE_IM 是**反转**语义：可获焦点的窗口置上它 = 「不需要输入法」= 挡住 IME。
  // 聚焦时必须**同时清掉**它（此前写成「置上」，正好会导致键盘弹不出来）。
  assert.match(service, /FLAG_ALT_FOCUSABLE_IM\.inv\(\)/, '聚焦时必须清掉 ALT_FOCUSABLE_IM（反转语义）');
  assert.equal(/focusable\)[\s\S]{0,200}?params\.flags or WindowManager\.LayoutParams\.FLAG_ALT_FOCUSABLE_IM/.test(service),
    false, '聚焦分支不得置上 ALT_FOCUSABLE_IM（会挡住输入法）');
  assert.ok(service.includes('setOnFocusChangeListener'), '输入框焦点变化触发 flag 切换');
  // 键盘遮挡：面板上移
  assert.ok(service.includes('fun applyImeInset('), '键盘 inset 处理存在');
  // baseY 必须可空：拖到顶部时 y 的合法值就是 0，用 0 当哨兵会复位错位。
  assert.ok(service.includes('private var baseY: Int? = null'), 'baseY 是可空（null = 未捕获）');
  assert.match(service, /baseY = null/, '拖拽时作废 inset 基准');
});

test('Kotlin：拖拽不抢消息区滚动（挂点必须在非滚动区）', () => {
  const service = read('plugins/screenOverlay/android/OverlayService.kt');
  // 反例：rootView.setOnTouchListener(dragListener) 会让 ScrollView 拿不到拖动
  assert.equal(/rootView\.setOnTouchListener/.test(service), false,
    '不得把拖拽挂在 rootView（会抢走消息区滚动）');
  assert.match(service, /ball\.setOnTouchListener\(dragListener\)/, '收起态：拖拽挂在球上');
  assert.match(service, /setOnTouchListener\(dragListener\)/, '展开态：拖拽挂在标题行');
});

test('Kotlin：消息留档（收起/展开重建视图不丢上下文）', () => {
  const service = read('plugins/screenOverlay/android/OverlayService.kt');
  assert.ok(service.includes('private val chatHistory = mutableListOf'), '消息留档容器存在');
  assert.ok(service.includes('private fun renderChatHistory()'), '展开时重画留档');
  assert.ok(service.includes('renderChatHistory()'), '展开流程里调用重画');
  // 收起态清视图引用（面板已摘除，留着就是悬挂引用）
  assert.match(service, /private fun showCollapsed\(\)[\s\S]{0,600}?chatMessages = null/,
    '收起时清 chatMessages 引用');
  // 留档也要有上限（与视图裁剪同口径）
  assert.match(service, /while \(chatHistory\.size > CHAT_MESSAGE_MAX\)/, '留档同样裁剪');
  // 死代码：panelContainer 写过没读过
  assert.equal(service.includes('panelContainer'), false, '不得留只写不读的死字段');
});

test('Kotlin：架构边界——OverlayService 本体不做业务；OverlayBrain 是 M2 的有意例外', () => {
  const service = read('plugins/screenOverlay/android/OverlayService.kt');
  // M2 大脑搬家后：OverlayService 本体仍是「UI + 事件壳」，LLM 调用全在 OverlayBrain.kt。
  // 旧断言「原生不得做业务」在 M2 被有意推翻（设计文档 §二），但边界仍要钉住：
  // 网络调用只允许出现在 OverlayBrain.kt，OverlayService 本体不得染指。
  const serviceCode = service.split('\n')
    .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
  for (const forbidden of ['sendChatMessage', 'runAgentTurn', 'confirm_flow', 'fetch(', 'OkHttpClient', 'createScreenCaptureIntent']) {
    assert.equal(serviceCode.includes(forbidden), false, `OverlayService 本体不得做业务（发现 ${forbidden}）`);
  }
  // 大脑在独立文件里（不与 UI/服务混在一个类）
  const brain = read('plugins/screenOverlay/android/OverlayBrain.kt');
  const brainCode = brain.split('\n')
    .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
  assert.ok(brainCode.includes('OkHttpClient'), 'OverlayBrain 直连 LLM（设计文档 3.2）');
  assert.ok(brainCode.includes('chat/completions'), '走 OpenAI 兼容流式端点');
  assert.ok(brainCode.includes('"stream"'), '流式（SSE）');
  // 无配置时回退 JS 管线（无快照 = 用户还没打开过 App，此时原生无凭据可用）
  assert.match(service, /hasConfig\(\)[\s\S]{0,200}?EVENT_CHAT_SEND/, '无配置时回退 JS 管线');
  // 配置快照由 JS 喂给原生（M2 安全前提：apiKey 走加密，不是明文 json）
  const configWriter = read('src/screenWatch/overlayConfig.js');
  assert.ok(configWriter.includes('writeOverlayConfig'), 'JS 侧有配置快照写入器');
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
