// 会话事件流的**只读回看**（纯函数，Node 可直测）。
//
// 背景：会话事件从 E4 起就落盘了（`.easychat/sessions/<id>.jsonl`），但界面上只有「导出」
// 一个动作——用户想知道「这一轮到底发生了什么」只能导出成文件再看。这里把事件归一成
// 可渲染的行（i18n key + 参数），界面只负责画。
//
// **如实记录一个事实**：`SESSION_EVENT_TYPES` 声明了 8 种，但 `appendSessionEvent` 全仓
// 只有 ChatPanel 三个写入点，实际只会出现 `user` / `assistant` / `tool_call`。另外 5 种
// （tool_result / plan_update / mode_change / compaction / branch_fork）**目前永远不会出现**。
// 本模块仍然为它们准备好文案——将来真写入了就能直接显示——但**不假装它们存在**：
// 未登记的类型一律走通用兜底（显示原始 type），不编一个不存在的中文名。

const MAX_PREVIEW = 80;

// 事件 → 一行预览：取**首行**（先按行切，再折叠空白——顺序反了的话换行会被折叠成空格，
// 取首行就永远取不到）、超长截断。事件里的 text 写入时已截到 1000，仍可能很长。
export function eventPreview(text, { max = MAX_PREVIEW } = {}) {
  const lines = String(text == null ? '' : text).split('\n');
  let value = '';
  for (const line of lines) {
    const trimmed = line.replace(/\s+/g, ' ').trim();
    if (trimmed) { value = trimmed; break; }
  }
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(1, max - 1))}…`;
}

function eventTime(ts) {
  const value = Number(ts) || 0;
  return value > 0 ? value : 0;
}

// HH:MM:SS。日志行的读法是「什么时候」优先，日期在会话内基本恒定，只给时分秒更省宽度。
// 放在纯函数里而不是面板里：面板已有 0 行余量式的约束，且这样能被 Node 直接测。
export function eventTimeLabel(ts) {
  const value = eventTime(ts);
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const pad = n => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// 单条事件 → 展示模型。返回 null 表示这条不该显示（没有 type 的坏行）。
export function summarizeSessionEvent(event) {
  if (!event || typeof event !== 'object') return null;
  const type = String(event.type || '').trim();
  if (!type) return null;

  const row = {
    id: String(event.id || `${type}-${eventTime(event.ts)}`),
    type,
    at: eventTime(event.ts),
    timeLabel: eventTimeLabel(event.ts),
    key: '',
    params: {},
  };

  switch (type) {
    case 'user':
      row.key = 'workspace.events.user';
      row.params = { text: eventPreview(event.text) };
      break;
    case 'assistant':
      // 出错的终稿要能一眼看出来——否则回看时「模型没回话」和「模型报错了」长得一样。
      row.key = event.isError === true ? 'workspace.events.assistantError' : 'workspace.events.assistant';
      row.params = { text: eventPreview(event.text) };
      break;
    case 'tool_call':
      row.key = 'workspace.events.toolCall';
      row.params = {
        name: String(event.name || '').trim() || '?',
        round: Number(event.round) || 0,
      };
      break;
    // 以下 5 种当前没有写入点（见文件头）。文案先备好，真写入了就直接可用。
    case 'tool_result':
      row.key = 'workspace.events.toolResult';
      row.params = { name: String(event.name || '').trim() || '?' };
      break;
    case 'plan_update':
      row.key = 'workspace.events.planUpdate';
      row.params = { count: Array.isArray(event.plan) ? event.plan.length : 0 };
      break;
    case 'mode_change':
      row.key = 'workspace.events.modeChange';
      row.params = { mode: String(event.mode || '').trim() || '?' };
      break;
    case 'compaction':
      row.key = 'workspace.events.compaction';
      row.params = { applied: String(event.applied || '').trim() || '?' };
      break;
    case 'branch_fork':
      row.key = 'workspace.events.branchFork';
      row.params = { from: String(event.from || '').trim() || '?' };
      break;
    default:
      // 前向兼容：未知类型显示原始 type，不吞信息。
      row.key = 'workspace.events.unknown';
      row.params = { type };
      break;
  }
  return row;
}

// 事件流 → 行列表。**倒序**（最近的在最上面）——回看时的第一诉求是「刚刚发生了什么」。
// `limit` 只截显示，`total` 如实报全量，界面才能说清「还有 N 条」。
export function summarizeSessionEvents(events, { limit = 50 } = {}) {
  const list = Array.isArray(events) ? events : [];
  const rows = [];
  for (const event of list) {
    const row = summarizeSessionEvent(event);
    if (row) rows.push(row);
  }
  const parsed = Number(limit);
  const safeLimit = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 50;
  return {
    rows: rows.slice(-safeLimit).reverse(),
    total: rows.length,
    truncated: rows.length > safeLimit,
  };
}
