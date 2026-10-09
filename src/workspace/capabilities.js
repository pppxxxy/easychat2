// 工作区能力的如实说明（纯数据 + 渲染键，零依赖，可 Node 直测）。
//
// 这段文案的存在理由：用户看到的「工作区」很容易被理解成「AI 能在我手机上随便
// 操作文件」。实际能力是有边界的，边界不说清楚就等于误导。
//
// 1→5 循环（这是 agent 工具循环的完整闭环）：
//   1. 接收用户请求
//   2. 拼接系统提示 + 会话上下文，发给模型
//   3. 模型决定发起工具调用（read / write / edit / bash …）
//   4. 执行工具，把结果回传给模型
//   5. 模型据此继续判断（可能多轮），直到给出最终回答
//
// 边界（必须逐条写明，且与代码实际行为一致）：
// - 工具集 = list / read / write / edit / export_docx（可改模式），外加可选的 run_shell
//   与 run_python；
// - run_shell 需要**单独开关**，且每条命令**逐条确认**，拒绝则不执行；
// - run_python 是**另一个开关**（与命令执行分开），同样逐条确认；
// - run_shell 只在应用内默认根生效：没有 root 权限的 shell 访问不到你选的
//   外部文件夹（content://），所以选了外部文件夹时该工具不注册；
// - shell 只能访问应用自己的沙盒与 /system/bin 等公开路径，不是手机上的完整终端；
// - Python 脚本跑在独立进程（:python）里，超时或点「停止」会杀掉那个进程——
//   Chaquopy 自身没有中断机制，这是唯一能停掉跑飞脚本的办法，主进程不受影响；
// - Python 没有运行时 pip，只能用已打进 APK 的库；
// - 本地模型 v1 不参与工具循环（降级为普通对话）。

export const CAPABILITY_STEPS = Object.freeze([
  { id: 'receive', labelKey: 'workspace.capability.step.receive' },
  { id: 'compose', labelKey: 'workspace.capability.step.compose' },
  { id: 'decide', labelKey: 'workspace.capability.step.decide' },
  { id: 'execute', labelKey: 'workspace.capability.step.execute' },
  { id: 'answer', labelKey: 'workspace.capability.step.answer' },
]);

export const CAPABILITY_LIMITS = Object.freeze([
  { id: 'tools', labelKey: 'workspace.capability.limit.tools' },
  // AGENTS.md（工作区记忆）：它不是「限制」而是「机制」，但因为会长期影响行为且
  // 可被 agent 自行改写，用户必须在能力说明里看到它、知道怎么删（自我演进 ≠ 失控）。
  { id: 'memory', labelKey: 'workspace.capability.limit.memory' },
  { id: 'shellSwitch', labelKey: 'workspace.capability.limit.shellSwitch' },
  { id: 'pythonSwitch', labelKey: 'workspace.capability.limit.pythonSwitch' },
  { id: 'pythonIsolation', labelKey: 'workspace.capability.limit.pythonIsolation' },
  { id: 'externalRoot', labelKey: 'workspace.capability.limit.externalRoot' },
  { id: 'shellScope', labelKey: 'workspace.capability.limit.shellScope' },
  // 持久会话（T7）：目录与环境变量跨命令保留（存在 .easychat/env.json），
  // 但**不是**真终端——需要 PTY 的交互式程序不支持，这条边界必须如实说。
  { id: 'shellSession', labelKey: 'workspace.capability.limit.shellSession' },
  { id: 'localModel', labelKey: 'workspace.capability.limit.localModel' },
  { id: 'githubImport', labelKey: 'workspace.capability.limit.githubImport' },
]);

export const CAPABILITY_TITLE_KEY = 'workspace.capability.title';
export const CAPABILITY_INTRO_KEY = 'workspace.capability.intro';
export const CAPABILITY_LIMITS_TITLE_KEY = 'workspace.capability.limitsTitle';

// 当前生效的工具清单（用于界面如实列出「现在到底开了哪些」）。
// settings 为归一化后的工作区设置；shellAvailable / pythonAvailable 表示原生模块是否可用。
export function activeWorkspaceTools(settings, { shellAvailable = false, pythonAvailable = false } = {}) {
  const source = settings && typeof settings === 'object' ? settings : {};
  const mode = source.mode;
  if (mode !== 'write' && mode !== 'read') return [];
  const tools = mode === 'write'
    ? ['list_workspace_files', 'read_workspace_file', 'create_workspace_dir', 'write_workspace_file', 'edit_workspace_file', 'export_workspace_docx']
    : ['list_workspace_files', 'read_workspace_file'];
  const appRoot = !source.location || source.location.kind !== 'saf';
  if (mode === 'write' && appRoot && source.allowCommandExecution === true && shellAvailable) {
    tools.push('run_shell');
  }
  if (mode === 'write' && appRoot && source.allowPythonExecution === true && pythonAvailable) {
    tools.push('run_python');
  }
  return tools;
}

// 界面用的渲染模型：把上面两段结构 + 当前状态拼成可直接渲染的键列表。
// 不在这里做翻译，交给调用方用 t() 渲染（i18n 的单一来源仍在 locales）。
//
// enabled 两个标志必须与 activeWorkspaceTools 的**判断条件完全一致**（含原生可用性）：
// 说明里写「开着」而工具清单里没有它，就是这张卡片最该避免的那种误导。
// 早先 shellEnabled 漏了 shellAvailable 这一项，原生模块缺失时会说「开着」而工具不存在。
export function capabilityViewModel(settings, { shellAvailable = false, pythonAvailable = false } = {}) {
  const source = settings && typeof settings === 'object' ? settings : {};
  const appRoot = !source.location || source.location.kind !== 'saf';
  const writeMode = source.mode === 'write';
  return {
    titleKey: CAPABILITY_TITLE_KEY,
    introKey: CAPABILITY_INTRO_KEY,
    steps: CAPABILITY_STEPS.map(step => ({ id: step.id, labelKey: step.labelKey })),
    limitsTitleKey: CAPABILITY_LIMITS_TITLE_KEY,
    limits: CAPABILITY_LIMITS.map(limit => ({ id: limit.id, labelKey: limit.labelKey })),
    tools: activeWorkspaceTools(source, { shellAvailable, pythonAvailable }),
    shellEnabled: writeMode && appRoot && source.allowCommandExecution === true && shellAvailable === true,
    pythonEnabled: writeMode && appRoot && source.allowPythonExecution === true && pythonAvailable === true,
  };
}
