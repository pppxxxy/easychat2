// 聊天内工具气泡的展示逻辑（纯函数，Node 可直测）。
//
// 背景：`runAgentTurn` 的 onToolEvent 只给 {phase, name, round, ok, error}，
// 而界面要说的是人话——「正在搜索…」「已搜索」这种。工具名 → 文案的映射、
// 以及「什么该显示、什么该收起」的判定集中在这里，界面只负责渲染。
//
// 为什么不把中文写进组件：项目有 no-hardcoded-chinese 门禁，用户可见文案必须
// 走 i18n。所以这里只产出 **i18n key 与参数**，组件再 t() 一次。
//
// 本模块同时持有气泡的**纯状态变换**（updateToolBubbles）：把一次工具事件折进消息
// 数组。放在这里而不是组件里，是因为「什么该显示」的判定必须只有一份（含隐藏判定，
// 见 chat/toolNoticeVisibility.js）。

import { ASSISTANT_ID, TOOL_BUBBLE_KIND } from './chatConstants.js';
import { isToolNoticeHidden } from './toolNoticeVisibility.js';

// 工具名 → 展示用的 i18n key 后缀。没登记的工具有兜底文案（显示原始工具名），
// 这样将来新增工具不会因为忘记登记而整块不显示。
const TOOL_LABEL_KEYS = {
  web_search: 'search',
  web_fetch: 'fetch',
};

// 有专属状态文案的工具。状态比工具名更要说人话：「正在抓取网页…」和「正在搜索…」
// 对用户是两件事；没登记的工具走通用文案（措辞工具中立，别写「正在搜索」）。
const TOOL_STATUS_SUFFIXES = new Set(['search', 'fetch']);

export function toolLabelKey(name) {
  const key = TOOL_LABEL_KEYS[String(name || '').trim()];
  return key ? `chat.toolBubble.name.${key}` : '';
}

// 状态文案 key：有专属文案的工具用它自己的，其余走通用。
// 注意这里查的是**后缀**（TOOL_LABEL_KEYS 的值），不是 toolLabelKey 的返回值——
// 后者已经是完整 key（2026-10-10 踩过：拿完整 key 去 Set 里查，永远查不到，
// 于是所有工具都退回通用文案）。
export function toolStatusKey(name, status) {
  const suffix = TOOL_LABEL_KEYS[String(name || '').trim()];
  const state = String(status || '');
  if (!state) return '';
  return suffix && TOOL_STATUS_SUFFIXES.has(suffix)
    ? `chat.toolBubble.status.${suffix}.${state}`
    : `chat.toolBubble.status.${state}`;
}

// 一次工具调用在界面上的两个阶段：运行中（running）/ 已结束（done / error）。
// 只取结果状态，不推断「成功但没结果」这类语义——那由工具自己写进 content。
export function toolBubbleState(event) {
  const name = String((event && event.name) || '').trim();
  if (!name) return null;
  const phase = String((event && event.phase) || '');
  if (phase === 'start') return { name, status: 'running', round: Number(event.round) || 0 };
  if (phase === 'end') {
    return {
      name,
      status: event.ok === false ? 'error' : 'done',
      round: Number(event.round) || 0,
      error: String((event && event.error) || ''),
    };
  }
  return null;
}

// 生成气泡的展示参数（供 t() 使用）。
// 返回 null 表示这个事件不该显示气泡（未知阶段 / 未知工具）。
export function toolBubbleView(state) {
  if (!state || !state.name) return null;
  const suffix = toolLabelKey(state.name);
  const nameParams = suffix ? { key: suffix } : { key: '', raw: state.name };
  return {
    status: state.status,
    // 未登记的工具直接显示原始名，不吞掉信息
    nameKey: suffix || 'chat.toolBubble.name.generic',
    nameParams,
    statusKey: toolStatusKey(state.name, state.status),
    error: state.error || '',
  };
}

// 事件流 → 气泡状态。同一轮里同一工具重复出现时，后者覆盖前者（start 被 end 覆盖）。
export function reduceToolEvents(events) {
  const list = Array.isArray(events) ? events : [];
  const byRound = new Map();
  list.forEach(event => {
    const state = toolBubbleState(event);
    if (!state) return;
    const key = `${state.round}\u0000${state.name}`;
    byRound.set(key, state);
  });
  return [...byRound.values()];
}

// 是否值得把工具过程显示出来：
// - 用户关掉了开关 → 不显示（连「正在搜索」也不要，避免打扰）；
// - 工具调用全部成功且已完成 → 默认仍显示（这是「可见」的意义），
//   但只保留一行，不逐轮堆叠。
export function shouldShowToolBubble({ enabled = false, state = null } = {}) {
  if (enabled !== true) return false;
  return !!state && !!state.status;
}

// 工具过程气泡的**纯状态变换**：把一次工具事件折进消息数组，返回新数组。
//
// 契约（每一条都有 tests/toolBubbleVisibility.test.mjs 的行为测试）：
// - name/status 任一为空 = 清除该 id 的气泡（本轮收尾用）；
// - 该工具被隐藏（总开关或单项开关）= **不挂出、也不保留**。判定发生在**追加之前**，
//   所以不存在「先闪一下再消失」——这正是需求里点名要避免的形态；
// - 失败（status === 'error'）永不被隐藏：判定在 isToolNoticeHidden 内部短路；
// - 隐藏判定**每次调用都重新求值**，读的是调用方传进来的最新 visibility：
//   已挂出的气泡在开关被改后，会在下一次工具事件时立即消失/出现（不需要等下一轮）；
// - 只动 id 等于本条气泡的消息，其余消息原样保留（不改原数组）。
export function updateToolBubbles(current, {
  id,
  name = '',
  status = '',
  error = '',
  visibility = null,
  now = 0,
} = {}) {
  const list = Array.isArray(current) ? current : [];
  const without = list.filter(item => item.id !== id);
  if (!name || !status) return without;
  if (isToolNoticeHidden(name, visibility, status)) return without;
  return [...without, {
    id,
    role: ASSISTANT_ID,
    text: '',
    kind: TOOL_BUBBLE_KIND,
    toolName: name,
    toolStatus: status,
    toolError: error,
    pending: true,
    transient: true,
    timestamp: now,
  }];
}

// 气泡的**接线器**：把一次工具事件接到宿主的状态上（React setMessages）。
//
// 单独抽出来的理由：这三件事必须可被行为测试钉住，而不是靠「源码里出现了某行」——
//   1. 可见性**每次事件都从 getVisibility() 现取**（不是本轮开始时快照），
//      所以用户在设置页拨完开关回到聊天页，正在跑的这一轮也会立即跟随；
//   2. 会话守卫（isCurrentSession）在调用点与状态更新回调里各查一次：
//      切走会话后落地的气泡不能串场；
//   3. 隐藏只影响「挂不挂气泡」，不吞事件、不抛错——工具循环照跑。
export function createToolBubbleApplier({ id, isCurrentSession, getVisibility, setMessages }) {
  const apply = update => {
    if (!isCurrentSession()) return;
    setMessages(current => (
      isCurrentSession()
        ? updateToolBubbles(current, {
          ...update,
          id,
          visibility: getVisibility(),
          now: Date.now(),
        })
        : current
    ));
  };
  return {
    apply,
    clear: () => apply({}),
    set: (name, status, error = '') => apply({ name, status, error }),
  };
}
