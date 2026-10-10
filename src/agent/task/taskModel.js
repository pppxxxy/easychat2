// 定时 Agent 任务：数据模型与归一化（纯函数，零 RN 依赖，Node 可直测）。
//
// 一条任务 = 某个角色在每天固定时刻执行一段 Agent 指令（可联网搜索 / 只读工作区），
// 最终由模型产出的一条文本作为「主动消息」落进该角色的单聊会话，并推送通知。
//
// 与「定时主动消息」（src/storage/moments.js 的 slot）是两套独立数据：
// 主动消息由原生直接调用模型生成问候；Agent 任务必须回到 JS 跑工具循环，
// 因此执行路径、工具门控与落库方式都不同，单独成域更清晰。

export const AGENT_TASK_MODES = ['WORK', 'EXACT'];

// 每个任务可选的会话衔接目标：空串表示「新建对话」（首次触发新建后固定复用）。
export function makeAgentTaskId() {
  return `atask-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// 角色人设摘要：与 ProactivePanel / runUserMomentComments 同口径（系统提示 + 描述 + 性格 + 场景）。
export function rolePersonaFromCharacter(character) {
  const source = character && typeof character === 'object' ? character : {};
  const parts = [source.systemPrompt, source.description, source.personality, source.scenario]
    .map(item => String(item || '').trim())
    .filter(Boolean);
  return parts.join('；');
}

function normalizeHour(value, fallback) {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n >= 0 && n <= 23 ? n : fallback;
}

function normalizeMinute(value, fallback) {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n >= 0 && n <= 59 ? n : fallback;
}

export function normalizeAgentTask(raw, index = 0) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const hour = normalizeHour(source.hour, 8);
  const minute = normalizeMinute(source.minute, 0);
  const roleId = String(source.roleId || '');
  const taskId = String(source.taskId || `atask-${index}-${roleId}-${hour}-${minute}`);
  return {
    taskId,
    roleId,
    roleName: String(source.roleName || ''),
    persona: String(source.persona || ''),
    hour,
    minute,
    mode: AGENT_TASK_MODES.includes(source.mode) ? source.mode : 'WORK',
    enabled: source.enabled !== false,
    // 交给 Agent 的指令正文（用户写的自然语言任务）。
    instruction: String(source.instruction || ''),
    revision: String(source.revision || ''),
    sessionTargetId: String(source.sessionTargetId || ''),
  };
}

export function normalizeAgentTaskList(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item, index) => normalizeAgentTask(item, index))
    .filter(item => item.roleId && item.taskId);
}

// 「HH:MM」展示用；不涉及 i18n（时间格式与语言无关）。
export function formatAgentTaskTime(task) {
  const source = task && typeof task === 'object' ? task : {};
  const hour = normalizeHour(source.hour, 0);
  const minute = normalizeMinute(source.minute, 0);
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

// 本地日期键（YYYY-MM-DD），与 proactiveInbox.buildProactiveMessageId 的日期部分同口径。
export function localDateKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  const pad = value => String(value).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 解析面板里的「HH:MM」时间输入；非法/不完整时回退到 defaultTime。
// 放在纯模块以便单测（面板是 RN 文件，Node 载不进）。
export function parseAgentTaskTimeInput(text, defaultTime = '08:00') {
  const match = String(text || '').trim().match(/^(\d{1,2})\s*[:：]\s*(\d{1,2})$/);
  if (!match) {
    const fallback = String(defaultTime || '08:00').match(/^(\d{1,2}):(\d{1,2})$/) || [null, '8', '0'];
    return { hour: Number(fallback[1]), minute: Number(fallback[2]) };
  }
  const hour = Math.min(23, Math.max(0, Number(match[1])));
  const minute = Math.min(59, Math.max(0, Number(match[2])));
  return { hour, minute };
}
