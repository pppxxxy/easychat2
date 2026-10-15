// 内置 MCP Server 的访问策略：**三档开关 + 写入前预览**。
//
// 为什么需要这一层：MCP 协议里没有「用户当场点头」这个环节，而本仓的工具执行闸门
// （agent/tools/registry.js 的 runTool）是「拿不到 confirm 回调 = 拒绝」。所以对外
// 暴露工具时必须在工具之前再放一道显式的、可审计的策略闸——用户点开的档位就是他
// 给出的总授权，预览（confirm）则是 agent 自己的义务。
//
// 三个档位（默认只开只读）：
//   read  —— 只读：读文件、搜索、看 git 状态/日志、读公告板。默认开。
//   write —— 写：建目录/写文件/替换、物化仓库、导出 docx/扩展包、提交与回滚、
//            写计划、发公告板消息。默认关。
//   exec  —— 执行：跑命令/跑 Python/触发云构建/装扩展包，以及会把工具表转交给模型
//            自己挑的 run_subagent / run_team / run_workflow（间接执行权等同直接执行权）。
//            默认关。
//
// **档位表不能照抄注册表的 readOnly**：本仓的 readOnly 是「不改已有工作区内容 /
// read 模式下也放行」的口径，于是 run_subagent、run_team、run_workflow、update_plan、
// materialize_repo、board_* 全都声明为 readOnly，但它们能间接执行、能写计划、能落盘。
// 对外暴露时按「能造成多大后果」重新分档，判据集中在这张表里，一处可审计；
// 新增工具必须在这里表态，否则 tools/list 不会列出它（tests/mcpServerPolicy.test.mjs 钉住）。

export const MCP_ACCESS_TIERS = Object.freeze(['read', 'write', 'exec']);

export const MCP_DEFAULT_TIERS = Object.freeze({ read: true, write: false, exec: false });

// 控制字段：从 arguments 里剥出来，不透传给工具（工具自己的 JSON Schema 里没有它们）。
//   confirm      —— 写/执行档的「我看过预览了，执行吧」
//   preview      —— 显式只要预览（等价于不带 confirm）
//   character_id —— 指定操作哪个角色沙盒（工作区工具的根是 root/<characterId>/）
export const MCP_CONTROL_FIELDS = Object.freeze(['confirm', 'preview', 'character_id']);

const READ_TOOLS = [
  'list_workspace_files',
  'read_workspace_file',
  'search_workspace',
  // 扩展导入（z1012z8）：搜索仓库只读 GitHub，不改任何本地状态。
  'search_extension_repos',
  'list_symbols',
  'find_references',
  'git_status',
  'git_diff',
  'git_log',
  'get_build_log',
  'board_read',
  'board_inbox',
  'skill',
  // FEAT-AC1：APP 设置只读两件。读设置不改任何东西，放只读档。
  'list_app_settings',
  'get_app_setting',
  // FEAT-AC2：音乐只读两件（列曲库 / 查播放状态）——不改任何东西。
  'list_music_library',
  'get_music_status',
];

const WRITE_TOOLS = [
  'create_workspace_dir',
  'write_workspace_file',
  'edit_workspace_file',
  'materialize_repo',
  'export_workspace_docx',
  'export_extension_pack',
  'git_commit',
  'git_discard',
  'update_plan',
  'board_post',
  'board_send',
  'board_task',
  // FEAT-AC1：改 APP 设置。属**写**档而非执行档——它只改配置值，不执行代码、
  // 不装扩展；但它确实改变用户环境，所以绝不能在只读档（默认只开只读档）。
  // 另注：它声明了 requiresConfirmation，本地 UI 会弹确认；MCP 会话里没有那个
  // 「当场点头的人」，与隐藏档的 ask_user 不同——这里**不隐藏**：
  // 写档默认关闭（MCP_DEFAULT_TIERS），开了写档就等于用户明确许可过写操作。
  'set_app_setting',
  // FEAT-AC2：控制音乐播放。属**写**档——它会改变正在播放的内容（会出声），
  // 但既不执行代码也不装扩展，故不入执行档。
  // 确认分级由宿主侧按 action 判定（只有 play/resume 弹，见 musicToolSchema 的
  // MUSIC_ACTIONS.needsConfirm）——MCP 这边写档本来就有 confirm:true 两步确认兜着。
  'control_music',
];

const EXEC_TOOLS = [
  'run_shell',
  'run_python',
  'run_remote_build',
  'run_workflow',
  'run_subagent',
  'run_team',
  'install_extension_pack',
  // 扩展导入（z1012z8 分支）：装进来的 skill/命令/MCP 都会被 agent 直接使用，
  // 且插件是会在 App 内跑的 JS——等同执行权。该工具尚不在 main 上，先占位。
  'import_extension',
];

// 永不暴露：需要「当场问用户」的工具。MCP 会话里没有那个用户，问了也没人答
// （registry 对这类工具的行为是「问不到 = 不执行」，列出来只会误导 agent）。
const HIDDEN_TOOLS = ['ask_user', 'confirm_flow'];

export const MCP_TOOL_TIERS = Object.freeze(
  Object.fromEntries([
    ...READ_TOOLS.map(name => [name, 'read']),
    ...WRITE_TOOLS.map(name => [name, 'write']),
    ...EXEC_TOOLS.map(name => [name, 'exec']),
    ...HIDDEN_TOOLS.map(name => [name, 'hidden']),
  ])
);

// 需要先看预览才允许执行的档位（写与执行）。
export function tierNeedsConfirm(tier) {
  return tier === 'write' || tier === 'exec';
}

export function normalizeMcpTiers(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    read: source.read !== undefined ? source.read === true : MCP_DEFAULT_TIERS.read,
    write: source.write === true,
    exec: source.exec === true,
  };
}

export function tierForTool(name) {
  return MCP_TOOL_TIERS[String(name || '')] || 'unknown';
}

// 第三方 MCP 服务器转发过来的工具（github_*、<id>__*）不进本服务器：那是「MCP 套 MCP」，
// 会把别人的服务器暴露成我们的工具，安全面与用户认知都对不上。聊天内工具（联网搜索）
// 也不进：它们由聊天会话按搜索插件配置临时注册，生命周期与这里无关。
const FORWARDED_MCP_PATTERN = /^[a-z0-9][a-z0-9-]*__/;

export function isExposableTool(definition) {
  const name = String((definition && definition.name) || '');
  if (!name) return false;
  if (definition.chatTool === true) return false;
  if (name.startsWith('github_') || FORWARDED_MCP_PATTERN.test(name)) return false;
  const tier = tierForTool(name);
  return tier === 'read' || tier === 'write' || tier === 'exec';
}

// 列出该档位组合下**真正可调用**的工具（含档位标注，供 tools/list 与文档共用）。
export function listExposedTools(definitions, tiers) {
  const resolved = normalizeMcpTiers(tiers);
  const list = Array.isArray(definitions) ? definitions : [];
  return list
    .filter(isExposableTool)
    .map(definition => ({ definition, tier: tierForTool(definition.name) }))
    .filter(item => resolved[item.tier] === true);
}

// 全部可暴露工具（忽略开关）：设置页用它展示「这个档位一旦打开会多出哪些工具」。
export function describeToolCatalog(definitions) {
  const list = Array.isArray(definitions) ? definitions : [];
  return list.filter(isExposableTool).map(definition => ({
    name: definition.name,
    description: String(definition.description || ''),
    tier: tierForTool(definition.name),
  }));
}

function formatArgs(args) {
  try {
    const text = JSON.stringify(args === undefined ? {} : args);
    return text.length > 600 ? `${text.slice(0, 600)}…` : text;
  } catch (error) {
    return '{}';
  }
}

function tierDisabledMessage(tier) {
  if (tier === 'write') {
    return '该工具属于「写入」档，当前未开启（设置 → MCP 服务器 → 允许写入）。'
      + '出于安全考虑，写入类工具默认关闭：开启后 agent 可以改动工作区文件、提交 git、安装/导出扩展包。';
  }
  if (tier === 'exec') {
    return '该工具属于「执行」档，当前未开启（设置 → MCP 服务器 → 允许执行）。'
      + '执行档包含跑命令、跑 Python、触发云构建、装扩展包，以及能把工具表转交给模型自己挑的子代理/团队/工作流。';
  }
  return '该工具属于「只读」档，但只读档当前被关闭了（设置 → MCP 服务器 → 允许读取）。';
}

// 预览文本：把「将要发生什么」写清楚，让 agent（和看它输出的人）能判断要不要继续。
export function buildPreview({ name, tier, args, definition }) {
  const lines = [
    `【未执行·预览】${name}（${tier === 'write' ? '写入' : '执行'}档）`,
    `参数：${formatArgs(args)}`,
    definition && definition.description ? `作用：${definition.description}` : '',
    '确认无误后请带 confirm: true 重新调用同一工具执行；不需要执行就到此为止。',
  ];
  return lines.filter(Boolean).join('\n');
}

// 单次调用的判决：execute / preview / denied。
// 纯函数——所有档位与权限判断都在这里，桥接层只负责把判决变成动作。
export function planToolCall({ name, definition, args, tiers } = {}) {
  const toolName = String(name || '');
  const tier = tierForTool(toolName);
  const controls = {};
  const rawArgs = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const cleanArgs = {};
  for (const key of Object.keys(rawArgs)) {
    if (MCP_CONTROL_FIELDS.includes(key)) controls[key] = rawArgs[key];
    else cleanArgs[key] = rawArgs[key];
  }
  if (!toolName || !definition || tier === 'unknown' || tier === 'hidden') {
    return {
      kind: 'denied',
      tier: tier === 'hidden' ? 'hidden' : 'unknown',
      args: cleanArgs,
      controls,
      message: tier === 'hidden'
        ? `工具 ${toolName} 不通过 MCP 暴露（它需要当场询问用户，MCP 会话里没有这个用户）。`
        : `工具 ${toolName} 不在本服务器的暴露清单里，无法调用。`,
    };
  }
  const resolved = normalizeMcpTiers(tiers);
  if (resolved[tier] !== true) {
    return { kind: 'denied', tier, args: cleanArgs, controls, message: tierDisabledMessage(tier) };
  }
  if (!tierNeedsConfirm(tier)) return { kind: 'execute', tier, args: cleanArgs, controls };
  // 写/执行档：默认只给预览，confirm:true 才真的动手（preview:true 显式只要预览）。
  const confirmed = controls.confirm === true && controls.preview !== true;
  if (!confirmed) {
    return {
      kind: 'preview',
      tier,
      args: cleanArgs,
      controls,
      message: buildPreview({ name: toolName, tier, args: cleanArgs, definition }),
    };
  }
  return { kind: 'execute', tier, args: cleanArgs, controls };
}
