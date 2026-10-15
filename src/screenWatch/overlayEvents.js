// 悬浮窗原生事件的纯解析层：事件名常量 + 参数归一。
// 不依赖 react-native，可在纯 Node 测试里直接加载（overlay.js 才触碰原生模块）。

export const OVERLAY_EVENT_CAPTURE = 'ScreenOverlay:onCapture';
export const OVERLAY_EVENT_CAPTURE_FAILED = 'ScreenOverlay:onCaptureFailed';
export const OVERLAY_EVENT_REQUEST_CAPTURE = 'ScreenOverlay:onRequestCapture';
export const OVERLAY_EVENT_STATE = 'ScreenOverlay:onState';
// FIX-4：采集链路打点（{ stage, detail, at }）。走独立事件而不是复用 capture/captureFailed：
// 那两条是业务语义，这条纯粹是诊断（写入诊断日志，DiagnosticsModal 可见）。
export const OVERLAY_EVENT_TRACE = 'ScreenOverlay:onTrace';
// SW3：悬浮窗 mini 聊天——用户在悬浮窗里发了话（原生 → JS）。
// payload: { text, scope }；scope 决定 JS 侧走聊天角色管线还是工作区 agent 管线。
export const OVERLAY_EVENT_CHAT_SEND = 'ScreenOverlay:onChatSend';
// FEAT-AC4 P0-A：窗内确认卡的用户决定（原生 → JS）。
// payload: { id, approved }；approved=false 同时覆盖「点了拒绝」与「超时自动拒绝」
//（reason 区分二者：'denied' vs 'timeout'——助手收尾文案不同，但语义都是「不执行」）。
export const OVERLAY_EVENT_CONFIRM_RESULT = 'ScreenOverlay:onConfirmResult';

// SW3：会话作用域（与 screenWatch/threads.js 的 THREAD_SCOPES 同值）。
export const OVERLAY_CHAT_SCOPES = Object.freeze(['chat', 'workspace']);

// 原生发来一条聊天输入：{ text, scope }。空文本视为无效事件（原生侧也会挡，
// 这里是第二道——事件通道不该把空消息送进模型）。
export function parseChatSendEvent(payload) {
  const text = String((payload && payload.text) || '').trim();
  if (!text) return null;
  const scope = OVERLAY_CHAT_SCOPES.includes(payload && payload.scope)
    ? payload.scope
    : 'chat';
  return { text, scope };
}

// FEAT-AC4 P0-A：原生回报的确认卡决定。
//
// 缺 id 一律视为无效（无法归属到某个挂起请求，结算了也没意义——反而可能
// 误结算另一个同 id 的请求）。
// reason: 'approved' | 'denied' | 'timeout'（原生侧给；缺失时按 approved 推断）。
export function parseConfirmResultEvent(payload) {
  const id = String((payload && payload.id) || '').trim();
  if (!id) return null;
  const approved = (payload && payload.approved) === true;
  const rawReason = String((payload && payload.reason) || '').trim();
  const reason = rawReason || (approved ? 'approved' : 'denied');
  return { id, approved, reason };
}

// JS → 原生推送一条消息（原生渲染成气泡/按钮组）。
// role: 'user' | 'assistant'；confirm 为 AS2 题卡（原生渲染成按钮组，点击经
// onChatSend 回传答案）。归一后返回可直接交给原生模块的对象。
export function buildChatPushPayload({ role = 'assistant', text = '', confirm = null } = {}) {
  const safeRole = role === 'user' ? 'user' : 'assistant';
  const body = String(text || '');
  const payload = { role: safeRole, text: body };
  if (confirm && Array.isArray(confirm.questions) && confirm.questions.length > 0) {
    payload.confirm = {
      questions: confirm.questions.map(item => ({
        id: String((item && item.id) || ''),
        text: String((item && item.text) || ''),
      })).filter(item => item.id && item.text),
    };
  }
  return payload;
}

// 原生回传的确认答案（点击按钮组）→ AS2 的答案形状（供 confirmFlowBridge 结算）。
// payload: { answers: [{ id, answer, custom? }] }。
export function parseChatConfirmAnswers(payload) {
  const list = Array.isArray(payload && payload.answers) ? payload.answers : [];
  const answers = list
    .map(item => {
      const id = String((item && item.id) || '');
      const answer = ['yes', 'no', 'custom'].includes(item && item.answer) ? item.answer : '';
      if (!id || !answer) return null;
      if (answer === 'custom') {
        const custom = String((item && item.custom) || '').trim();
        return custom ? { id, answer, custom } : null;
      }
      return { id, answer };
    })
    .filter(Boolean);
  return answers.length > 0 ? answers : null;
}

// 原生抓到一帧：{ path }（file:// URI）。无路径视为无效事件。
export function parseCaptureEvent(payload) {
  const path = String((payload && payload.path) || '');
  if (!path) return null;
  return { path };
}

// 原生采集失败：{ reason }。reason 用于区分处置方式（授权失效 vs 一般失败），缺省按未知。
export function parseCaptureFailedEvent(payload) {
  return { reason: String((payload && payload.reason) || 'unknown') };
}

// 采集链路打点：{ stage, detail, at }。stage 为空视为无效（打点没有阶段名就没有诊断价值）。
export function parseTraceEvent(payload) {
  const stage = String((payload && payload.stage) || '').trim();
  if (!stage) return null;
  return {
    stage,
    detail: String((payload && payload.detail) || '').trim(),
    at: Number(payload && payload.at) || Date.now(),
  };
}

// 采集失败原因码 → 人话。**必须区分原因**：用户看到的「没能抓到画面，请重试」对
// 「授权失效」这种需要用户去重开悬浮窗的情况毫无帮助（他只会反复重试）。
// 未知码回落到通用文案（不把内部码当文案丢给用户）。
export const CAPTURE_FAILURE_KEYS = Object.freeze({
  'no-projection': 'screenWatch.overlay.captureFailed.permission',
  'projection-denied': 'screenWatch.overlay.captureFailed.permission',
  'projection-invalid': 'screenWatch.overlay.captureFailed.permission',
  'no-frame': 'screenWatch.overlay.captureFailed.noFrame',
  'no-manager': 'screenWatch.overlay.captureFailed.permission',
  timeout: 'screenWatch.overlay.captureFailed.timeout',
});

export function captureFailureKey(reason) {
  return CAPTURE_FAILURE_KEYS[String(reason || '')] || 'screenWatch.overlay.captureFailed';
}

// 启动失败原因码 → 提示文案的两个键（title/body）。
//
// 为什么做成纯函数：这个映射要同时被扩展页与设置页使用，而两处此前各写了一套 if/else，
// 已经漂移（设置页只说「启动失败」，扩展页会分别提示悬浮窗权限/投屏授权）。抽成一处
// 既能被 Node 直测，也保证两个入口说同样的话。
//
// `null` 表示「只弹一个通用提示、没有专门的标题」（UNSUPPORTED / START_FAILED 两档
// 复用现成文案，避免为一个罕见分支新增词条）。
export const START_FAILURE_ALERTS = Object.freeze({
  unsupported: { titleKey: null, bodyKey: 'screenWatch.overlay.unsupported' },
  'overlay-permission': {
    titleKey: 'screenWatch.overlay.permission.title',
    bodyKey: 'screenWatch.overlay.permission.body',
  },
  'capture-permission': {
    titleKey: 'screenWatch.overlay.capturePerm.title',
    bodyKey: 'screenWatch.overlay.capturePerm.body',
  },
  'start-failed': { titleKey: null, bodyKey: 'screenWatch.overlay.startFailed' },
});

export function overlayStartFailureAlert(reason) {
  return START_FAILURE_ALERTS[String(reason || '')] || START_FAILURE_ALERTS['start-failed'];
}

// 服务启停：{ active }。缺字段按 false 处理。
export function parseStateEvent(payload) {
  return { active: !!(payload && payload.active) };
}
