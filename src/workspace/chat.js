// 工作区指令对话框的纯逻辑：组装「直连 Agent」的系统提示与消息数组。
//
// 与聊天页不同，这里不做角色扮演/世界书/记忆那套 Prompt 流水线——工作区助手只关心
// 沙盒文件操作，给一段精简、贴近工具的系统提示即可。所有函数无副作用，可 Node 直测。

export const WORKSPACE_AGENT_BASE_PROMPT = [
  '你是「工作区文件助手」，帮用户在本地沙盒里管理文本文件。',
  '所有路径都是相对沙盒根目录的相对路径，目录以 / 结尾。',
  '优先调用工作区工具完成实际操作，不要凭空编造文件内容；完成后用简洁中文说明做了什么。',
].join('');

const MODE_HINTS = Object.freeze({
  ask: '当前是「只读问答」模式：没有可用的工作区工具，只能讨论，不能列出或改动文件。',
  read: '当前是「只读」模式：可以列出与读取沙盒内的文件，不能创建或修改。',
  write: '当前是「可改」模式：可以列出、读取、新建目录、写入与编辑文本文件，并把文本导出为 Word。',
});

// 执行类工具的如实说明。**只在工具真的注册了的时候才写进提示词**——判据是注册表
// 返回的工具清单，不是设置里的开关：开关开着但原生模块缺失、或工作区根是外部文件夹时
// 工具并不存在，提示词不能替它撒谎（说了「可以跑」而调不动，模型会反复尝试然后乱解释）。
export const EXECUTION_TOOL_HINTS = Object.freeze({
  run_shell: '需要执行 shell 命令时调用 run_shell（每条命令会先请用户确认，拒绝则不执行）。',
  run_python: '需要跑代码或做精确计算时，直接调用 run_python 真跑，再把它的真实输出讲给用户；'
    + '不要只在回答里写出代码片段或 `>>>` 会话就当作已经执行过——写出代码不等于真的跑过，'
    + '用户要的是真实执行结果。',
});

export function workspaceExecutionToolHints(tools) {
  const names = Array.isArray(tools) ? tools : [];
  return Object.keys(EXECUTION_TOOL_HINTS)
    .filter(name => names.includes(name))
    .map(name => EXECUTION_TOOL_HINTS[name]);
}

export function workspaceAgentModeHint(mode) {
  return MODE_HINTS[mode] || MODE_HINTS.ask;
}

// tools：当前**真正注册进表**的工具名清单（见 ChatPanel 的调用处）。
// 不传就等于「没有任何执行类工具」，提示词里也不会提——宁可少说，不能说假话。
// 执行类说明另外要求「可改」模式：两个执行工具的门控都是 NOT_WRITE_MODE，
// 这里自己再拦一道，不靠「调用方一定传对」来保证不说假话。
export function buildWorkspaceAgentSystemPrompt({ mode = 'ask', characterName = '', tools } = {}) {
  const lines = [WORKSPACE_AGENT_BASE_PROMPT];
  const name = String(characterName || '').trim();
  if (name) lines.push(`你正在为角色「${name}」的工作区服务。`);
  lines.push(workspaceAgentModeHint(mode));
  if (mode === 'write') lines.push(...workspaceExecutionToolHints(tools));
  return lines.join('\n');
}

// 把本地会话（含错误气泡）投影成模型可读的 history：只保留有文字的 user/assistant。
export function projectWorkspaceChatHistory(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const projected = [];
  for (const item of list) {
    if (!item || (item.role !== 'user' && item.role !== 'assistant')) continue;
    const content = String(item.content || '').trim();
    if (!content) continue;
    projected.push({ role: item.role, content });
  }
  return projected;
}

// 组装本轮请求：system + 历史 + 当前用户消息（有图片时用多模态 content 数组）。
export function buildWorkspaceAgentMessages({ systemPrompt, history, userText, images } = {}) {
  const messages = [{ role: 'system', content: String(systemPrompt || '') }];
  for (const item of projectWorkspaceChatHistory(history)) messages.push(item);

  const text = String(userText || '').trim();
  const dataUris = (Array.isArray(images) ? images : [])
    .map(item => (typeof item === 'string' ? item : String((item && item.dataUri) || '')))
    .filter(Boolean);
  if (dataUris.length > 0) {
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: text || '[用户发来图片]' },
        ...dataUris.map(url => ({ type: 'image_url', image_url: { url } })),
      ],
    });
  } else if (text) {
    messages.push({ role: 'user', content: text });
  }
  return messages;
}
