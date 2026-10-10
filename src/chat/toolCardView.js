// 工作区 agent 工具过程的**卡片模型**（纯函数，Node 可直测）。
//
// 背景：工作区此前只有一行会闪过的 `toolStatus`（ChatPanel 的 `setToolStatus`），
// 用户看不到「哪一步读了什么、改了什么、失败在哪」，只能等终稿。
// 这里把 `onToolEvent` 的事件流归一成**逐条工具卡片**，界面只负责渲染。
//
// 与 `chat/toolBubbleView.js` 的分工（别合并，两者语义不同）：
// - 那个是**聊天页** web_search/web_fetch 的两阶段气泡：只登记了两个工具，
//   且按「轮次 + 工具名」**折叠**（同一轮同名工具只留最后一条）。
// - 这里是**工作区**的逐次调用卡片：覆盖全部工作区工具，且**保留每一次调用**
//   （同一轮同名工具调两次 = 两张卡），因为「读了三遍同一个文件」本身是信息。
//
// 文案纪律：本模块只产出 **i18n key 与参数**，不写中文（no-hardcoded-chinese 门禁），
// 界面再 `t()` 一次。未登记的工具**回退显示原始工具名**——宁可显示 `run_shell`，
// 也不要吞掉信息或编一个不存在的中文名。

export const TOOL_CARD_STATUS = Object.freeze({
  RUNNING: 'running',
  DONE: 'done',
  ERROR: 'error',
});

// 工具名 → 标签 i18n key 后缀。**没登记的一律返回空串**，由界面回退到原始工具名
// （将来新增工具不会因为忘记登记而整块不显示）。
const TOOL_LABEL_SUFFIX = {
  read_workspace_file: 'read',
  write_workspace_file: 'write',
  edit_workspace_file: 'edit',
  list_workspace_files: 'list',
  search_workspace: 'search',
  create_workspace_dir: 'mkdir',
  update_plan: 'plan',
  materialize_repo: 'materialize',
  get_build_log: 'buildLog',
  run_subagent: 'subagent',
  run_shell: 'shell',
  run_python: 'python',
  run_remote_build: 'remoteBuild',
  export_workspace_docx: 'docx',
};

export function toolCardLabelKey(name) {
  const suffix = TOOL_LABEL_SUFFIX[String(name || '').trim()];
  return suffix ? `workspace.toolCard.name.${suffix}` : '';
}

// 参数摘要要挑的字段，按「最能说明这一步动了什么」排序。
// 顺序是有意的：`path` 比 `name` 更能说明问题；`command` 只对执行类出现。
const ARG_PRIORITY = [
  'path', 'paths', 'file', 'command', 'pattern', 'query', 'url',
  'subdir', 'repo', 'workflow', 'runId', 'task', 'name', 'prompt',
];

function clip(text, max) {
  const value = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(1, max - 1))}…`;
}

// 参数 → 一行摘要。拿不到有用字段时返回空串（界面就不显示这一行），
// **不**退化成整段 JSON——那对用户没有信息量，还会把卡片撑爆。
export function summarizeToolArgs(name, args, { max = 80 } = {}) {
  const tool = String(name || '').trim();
  const value = args && typeof args === 'object' ? args : null;
  if (!value) return '';

  // 计划：说「几步」比列出步骤名更有用（步骤正文在进度条里）。
  if (tool === 'update_plan') {
    const steps = Array.isArray(value.plan) ? value.plan.length : 0;
    return steps > 0 ? String(steps) : '';
  }
  // 子代理：可能一次派多个任务。
  if (tool === 'run_subagent') {
    const tasks = Array.isArray(value.tasks) ? value.tasks.length : (value.task ? 1 : 0);
    return tasks > 0 ? String(tasks) : '';
  }

  for (const key of ARG_PRIORITY) {
    const raw = value[key];
    if (raw === undefined || raw === null) continue;
    if (Array.isArray(raw)) {
      if (raw.length === 0) continue;
      return clip(raw.map(item => (typeof item === 'string' ? item : '')).filter(Boolean).join(', '), max);
    }
    if (typeof raw === 'string' || typeof raw === 'number') {
      const text = clip(raw, max);
      if (text) return text;
    }
  }
  return '';
}

// 事件 → 新卡片列表（纯，不就地改入参）。
//
// 配对规则：`start` 追加一张 running 卡；`end` 更新**最近一张「同轮 + 同名 + 仍在 running」**的卡。
// 为什么可以这样配对：`loop.js` 里同一轮的工具是**顺序 await** 的（start→end 严格成对、不交叠），
// 所以「最近一张 running」就是这次调用对应的卡；不需要（也不该）按 id 配对——事件里没有 id。
export function applyToolEvent(cards, event, { maxSummary = 80 } = {}) {
  const list = Array.isArray(cards) ? cards : [];
  const name = String((event && event.name) || '').trim();
  const phase = String((event && event.phase) || '');
  if (!name) return list;
  const round = Number(event && event.round) || 0;

  if (phase === 'start') {
    const seen = list.filter(item => item && item.round === round && item.name === name).length;
    return [...list, {
      id: `${round}-${name}-${seen}`,
      name,
      round,
      status: TOOL_CARD_STATUS.RUNNING,
      summary: summarizeToolArgs(name, event && event.args, { max: maxSummary }),
      error: '',
    }];
  }

  if (phase === 'end') {
    let index = -1;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const item = list[i];
      if (item && item.round === round && item.name === name && item.status === TOOL_CARD_STATUS.RUNNING) {
        index = i;
        break;
      }
    }
    // 没有配对的 start（例如订阅从半路开始）：不编一张卡，直接忽略——
    // 凭空补一张会让「哪一步真的跑了」变得不可信。
    if (index < 0) return list;
    const ok = !(event && event.ok === false);
    const next = list.slice();
    next[index] = {
      ...list[index],
      status: ok ? TOOL_CARD_STATUS.DONE : TOOL_CARD_STATUS.ERROR,
      error: ok ? '' : clip((event && event.error) || '', maxSummary),
    };
    return next;
  }

  return list;
}

// 卡片列表 → 展示统计（界面用它决定「要不要折叠」与「显示几条」）。
export function summarizeToolCards(cards) {
  const list = (Array.isArray(cards) ? cards : []).filter(Boolean);
  let running = 0;
  let failed = 0;
  for (const item of list) {
    if (item.status === TOOL_CARD_STATUS.RUNNING) running += 1;
    else if (item.status === TOOL_CARD_STATUS.ERROR) failed += 1;
  }
  return { total: list.length, running, failed, done: list.length - running - failed };
}
