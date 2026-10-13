// 悬浮窗原生事件的纯解析层：事件名常量 + 参数归一。
// 不依赖 react-native，可在纯 Node 测试里直接加载（overlay.js 才触碰原生模块）。

export const OVERLAY_EVENT_CAPTURE = 'ScreenOverlay:onCapture';
export const OVERLAY_EVENT_CAPTURE_FAILED = 'ScreenOverlay:onCaptureFailed';
export const OVERLAY_EVENT_REQUEST_CAPTURE = 'ScreenOverlay:onRequestCapture';
export const OVERLAY_EVENT_STATE = 'ScreenOverlay:onState';
// SW3：悬浮窗 mini 聊天——用户在悬浮窗里发了话（原生 → JS）。
// payload: { text, scope }；scope 决定 JS 侧走聊天角色管线还是工作区 agent 管线。
export const OVERLAY_EVENT_CHAT_SEND = 'ScreenOverlay:onChatSend';

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

// 服务启停：{ active }。缺字段按 false 处理。
export function parseStateEvent(payload) {
  return { active: !!(payload && payload.active) };
}
