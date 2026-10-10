// 工作区指令对话框的纯逻辑：组装「直连 Agent」的系统提示与消息数组。
//
// 与聊天页不同，这里不做角色扮演/世界书/记忆那套 Prompt 流水线——工作区助手只关心
// 沙盒文件操作，给一段精简、贴近工具的系统提示即可。所有函数无副作用，可 Node 直测。

import { workspaceAgentsSection } from './agents.js';
import { workspaceMemorySection } from './memory.js';
import { formatReadLogLine } from './readLog.js';
import { workspaceSkillsSection } from './skills.js';
import { COMPACTION_AUTHORITY_NOTE } from '../chat/compaction.js';

export const WORKSPACE_AGENT_BASE_PROMPT = [
  '你是「工作区文件助手」，帮用户在本地沙盒里管理文本文件。',
  '所有路径都是相对沙盒根目录的相对路径，目录以 / 结尾。',
  '优先调用工作区工具完成实际操作，不要凭空编造文件内容；完成后用简洁中文说明做了什么。',
  // 规划引导（能力升级任务书 A0）：让多步任务先见清单再动手，减少「边想边做」的漂移。
  '预计需要三步以上的任务：动手前先在回复里列出步骤清单，逐步执行、完成一步勾掉一步。',
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

// 验证闭环（能力升级任务书 A0）：不绑定具体工具——只要**任一执行工具可用**就注入
//（它说的是「改完要验证」这个流程约定，谁可用都成立）。**刻意不点名 run_shell /
// run_python**：这段文本在「只注册了其中一个」的会话里同样会出现，点名另一个等于
// 承诺一个调不动的能力（与「宁可少说，不能说假话」同款纪律——测试钉死）。
// 原则：不带病收尾。验证不过就继续修，不许把没验证的改动当完成汇报。
export const EXECUTION_VERIFY_HINT = '改完代码或配置文件后，在给出结论前必须跑一次验证'
  + '（跑测试、语法检查或直接运行都可以），把验证结果写进结论；'
  + '验证不过就继续修，不要带病收尾。';

// 计划工具的引导（A3）：与执行类同款纪律——**只在工具真的注册了时注入**。
// 与 BASE_PROMPT 的「三步以上先列清单」配合：那条讲原则，这条讲用什么记。
export const PLAN_TOOL_HINT = '多步任务先用 update_plan 记录步骤清单，每完成一步更新一次状态，让进度对用户可见。';

// 物化工具的引导（C2）：只对「能跑 shell 的形态」说——read 模式的 read 工具会
// 自动按需物化，提了反而多余；write 模式要在终端/run_shell 里搜 repos/ 下的代码，
// 没物化的部分搜不到，这条提示防「搜了个空就下结论」。
export const MATERIALIZE_TOOL_HINT = 'repos/ 下带云朵标记（未物化）的文件不在本地：要在终端或 run_shell 里搜索、处理它们之前，先用 materialize_repo 把目标范围批量下载。';

export function workspaceExecutionToolHints(tools) {
  const names = Array.isArray(tools) ? tools : [];
  const hints = Object.keys(EXECUTION_TOOL_HINTS)
    .filter(name => names.includes(name))
    .map(name => EXECUTION_TOOL_HINTS[name]);
  if (hints.length > 0) hints.push(EXECUTION_VERIFY_HINT);
  return hints;
}

export function workspaceAgentModeHint(mode) {
  return MODE_HINTS[mode] || MODE_HINTS.ask;
}

// tools：当前**真正注册进表**的工具名清单（见 ChatPanel 的调用处）。
// 不传就等于「没有任何执行类工具」，提示词里也不会提——宁可少说，不能说假话。
// 执行类说明另外要求「可改」模式：两个执行工具的门控都是 NOT_WRITE_MODE，
// 这里自己再拦一道，不靠「调用方一定传对」来保证不说假话。
// memory：工作区记忆文件（AGENTS.md）的原文，由 ChatPanel 每轮直读传入；
// 不传/为空 = 这个工作区没有记忆文件，提示词与旧行为完全一致。
// skills：工作区技能清单 [{ name, description }]（渐进披露的第一层）。
// **只在有文件工具的形态下注入**（read/write）：清单里写着「用 read 工具读全文」，
// 而 ask 模式一个工具都没有——说了模型也读不到，只会反复尝试然后乱解释。
// readLog：本会话已读登记条目（A5），同样只在有读工具的形态下注入；空则不注入。
// agents：工作区定义的分身子弟清单（E3），只在 run_subagent 真注册时注入（同款纪律）。
export function buildWorkspaceAgentSystemPrompt({ mode = 'ask', characterName = '', tools, memory, skills, readLog, agents } = {}) {
  const lines = [WORKSPACE_AGENT_BASE_PROMPT];
  const name = String(characterName || '').trim();
  if (name) lines.push(`你正在为角色「${name}」的工作区服务。`);
  // 记忆段放在模式说明之前：先讲「这个工作区的长期约定」，再讲「这一轮能做什么」。
  const memorySection = workspaceMemorySection(memory);
  if (memorySection) lines.push(memorySection);
  // N2：压缩权威声明（静态行，放在 readLog 之前以保前缀缓存契约）——[历史压缩] 摘要
  // 仅供参考、不构成授权。
  lines.push(COMPACTION_AUTHORITY_NOTE);
  if (mode === 'read' || mode === 'write') {
    const skillsSection = workspaceSkillsSection(skills);
    if (skillsSection) lines.push(skillsSection);
    // E3：分身清单——只在 run_subagent 真注册时注入（说了调不动不如不说）。
    if (Array.isArray(tools) && tools.includes('run_subagent')) {
      const agentsSection = workspaceAgentsSection(agents);
      if (agentsSection) lines.push(agentsSection);
    }
    // A3：计划工具引导——工具没注册就不提（说了调不动，模型会反复试然后乱解释）。
    if (Array.isArray(tools) && tools.includes('update_plan')) lines.push(PLAN_TOOL_HINT);
  }
  lines.push(workspaceAgentModeHint(mode));
  if (mode === 'write') {
    lines.push(...workspaceExecutionToolHints(tools));
    // C2：物化引导（只在工具真注册时注入——同款纪律）。
    if (Array.isArray(tools) && tools.includes('materialize_repo')) lines.push(MATERIALIZE_TOOL_HINT);
  }
  // E1 前缀缓存：readLog 行是**每轮都变**的最高频动态项（每读一个文件就多一行），
  // 必须放在 systemPrompt 的**最末尾**——提供商的前缀缓存按 token 序列工作，它变化
  // 时只让「自己之后」的内容 miss（这里后面没有别的行），系统提示前半段与既有的
  // 静态约定全部保住。**行序是缓存契约**：静态段（身份/技能/引导）在前、高频动态
  // 段在后，别再往 readLog 后面塞任何内容（测试钉死）。
  if (mode === 'read' || mode === 'write') {
    const readLogLine = formatReadLogLine(readLog);
    if (readLogLine) lines.push(readLogLine);
  }
  return lines.join('\n');
}

// E1：工具顺序签名——提供商的前缀缓存把 tools 定义序列计入缓存键，**顺序一变全 miss**。
// 「顺序是契约」由 listToolsForMode 的纯函数顺序 + 测试钉死；这里是运行期兜底的
// 比较工具：宿主对同一 mode 的前后两次签名比对，漂移时开发期告警（生产静默）。
// 兼容两种形态：工具定义数组（{ function: { name } }）或纯名字数组。
export function toolOrderSignature(tools) {
  return (Array.isArray(tools) ? tools : [])
    .map(item => {
      if (typeof item === 'string') return item;
      return String(
        (item && item.function && item.function.name)
        || (item && item.name)
        || ''
      );
    })
    .filter(Boolean)
    .join(',');
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
