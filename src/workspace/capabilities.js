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
// - 工具集 = list / read / write / edit / export_docx（可改模式），外加可选的 run_shell；
// - run_shell 需要**单独开关**，且每条命令**逐条确认**，拒绝则不执行；
// - run_shell 只在应用内默认根生效：没有 root 权限的 shell 访问不到你选的
//   外部文件夹（content://），所以选了外部文件夹时该工具不注册；
// - shell 只能访问应用自己的沙盒与 /system/bin 等公开路径，不是手机上的完整终端；
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
  { id: 'shellSwitch', labelKey: 'workspace.capability.limit.shellSwitch' },
  { id: 'externalRoot', labelKey: 'workspace.capability.limit.externalRoot' },
  { id: 'shellScope', labelKey: 'workspace.capability.limit.shellScope' },
  { id: 'localModel', labelKey: 'workspace.capability.limit.localModel' },
]);

export const CAPABILITY_TITLE_KEY = 'workspace.capability.title';
export const CAPABILITY_INTRO_KEY = 'workspace.capability.intro';
export const CAPABILITY_LIMITS_TITLE_KEY = 'workspace.capability.limitsTitle';

// 当前生效的工具清单（用于界面如实列出「现在到底开了哪些」）。
// settings 为归一化后的工作区设置；shellAvailable 表示原生模块是否可用。
export function activeWorkspaceTools(settings, { shellAvailable = false } = {}) {
  const source = settings && typeof settings === 'object' ? settings : {};
  const mode = source.mode;
  if (mode !== 'write' && mode !== 'read') return [];
  const tools = mode === 'write'
    ? ['list_workspace_files', 'read_workspace_file', 'create_workspace_dir', 'write_workspace_file', 'edit_workspace_file', 'export_workspace_docx']
    : ['list_workspace_files', 'read_workspace_file'];
  if (mode === 'write' && source.allowCommandExecution === true
    && source.location && source.location.kind !== 'saf' && shellAvailable) {
    tools.push('run_shell');
  }
  return tools;
}

// 界面用的渲染模型：把上面两段结构 + 当前状态拼成可直接渲染的键列表。
// 不在这里做翻译，交给调用方用 t() 渲染（i18n 的单一来源仍在 locales）。
export function capabilityViewModel(settings, { shellAvailable = false } = {}) {
  const source = settings && typeof settings === 'object' ? settings : {};
  return {
    titleKey: CAPABILITY_TITLE_KEY,
    introKey: CAPABILITY_INTRO_KEY,
    steps: CAPABILITY_STEPS.map(step => ({ id: step.id, labelKey: step.labelKey })),
    limitsTitleKey: CAPABILITY_LIMITS_TITLE_KEY,
    limits: CAPABILITY_LIMITS.map(limit => ({ id: limit.id, labelKey: limit.labelKey })),
    tools: activeWorkspaceTools(source, { shellAvailable }),
    shellEnabled: source.allowCommandExecution === true
      && source.mode === 'write'
      && (!source.location || source.location.kind !== 'saf'),
  };
}
