// 工作区指令对话框的纯逻辑：组装「直连 Agent」的系统提示与消息数组。
//
// 与聊天页不同，这里不做角色扮演/世界书/记忆那套 Prompt 流水线——工作区助手只关心
// 沙盒文件操作，给一段精简、贴近工具的系统提示即可。所有函数无副作用，可 Node 直测。

import { workspaceAgentsSection } from './agents.js';
import { workspaceTeamsSection } from './teams.js';
import { workspaceMemorySection } from './memory.js';
import { formatReadLogLine } from './readLog.js';
import { workspaceSkillsSection } from './skills.js';
import { COMPACTION_AUTHORITY_NOTE } from '../chat/compaction.js';

// FEAT-AC4 P1：**世界观边界**——APP 自身功能不是代码仓库的一部分。
//
// 为什么需要（真机实测的病灶）：用户问「你能帮我发动态吗」，助手去 `grep` 代码仓库
// 找 `src/` 下的 Moments 文件——它把「APP 的功能」当成了「代码仓库里的功能」。
// 工作区助手的世界观此前只有文件沙盒，没有任何「app 自身功能」的概念。
//
// 这段是**静态**的：它讲的是「去哪找」这个永远成立的约定，不点名任何具体工具
//（点名了就必须有——见下方 APP_FEATURE_TOOL_HINTS 的条件注入纪律）。
export const APP_FEATURE_BOUNDARY_PROMPT =
  '重要：APP 自身的功能（设置、音乐、提醒、动态、日记、主动消息、书籍、插件等）'
  + '**不是这个代码仓库的一部分**，不要用文件工具去 src/ 里搜索或修改它们——'
  + '那些目录里只有实现代码，改了也不会生效。这类需求要用专门的「应用」工具；'
  + '若当前没有对应的工具，请如实说明并指引用户到 App 界面上操作，不要假装改好了。';

// 已实际注册的「应用」工具 → 提示词里的如实说明。
//
// **条件注入**（与 EXECUTION_TOOL_HINTS 同款纪律）：只在注册表真返回了该工具时才写进
// 提示词。说了「可以放歌」但工具没注册，模型会反复尝试然后乱解释（本仓反复踩过）。
export const APP_FEATURE_TOOL_HINTS = Object.freeze({
  list_app_settings: '查看/修改 App 设置用 list_app_settings / get_app_setting / set_app_setting。',
  list_music_library: '查看曲库与歌单用 list_music_library，控制播放用 control_music。',
  list_reminders: '设置一次性提醒用 set_reminder（绝对时间），查看用 list_reminders，取消用 cancel_reminder。',
});

// 按实际注册的工具清单组装「应用工具」段；一个都没有时返回空串（不写空承诺）。
export function appFeatureToolSection(tools) {
  const list = Array.isArray(tools) ? tools : [];
  const hints = Object.keys(APP_FEATURE_TOOL_HINTS)
    .filter(name => list.includes(name))
    .map(name => APP_FEATURE_TOOL_HINTS[name]);
  if (hints.length === 0) return '';
  return `[应用工具] 以下是可用的 App 功能工具：\n${hints.join('\n')}`;
}

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

// repos/ 快照的语义说明（2026-10-18）。
//
// 为什么需要这条：用户实测报上来一个真实误判——工作区 agent 被要求「拉取 easychat2
// 远端仓库」，它**确实拉下来了**（列出了 package.json / app.json / babel.config.js），
// 但接着回答「本副本没有 remote 配置、环境没有 git 二进制、materialize 失败，三者至少
// 解决两个才能拉取」。三点都对，**结论错了**：它已经拉到了，却把「做不到 git fetch」
// 讲成「做不到拉取」，最后还让用户去准备一个其实不需要准备的环境。
//
// 根因是提示词里从没说过 repos/ 是什么：模型只能自己猜，于是拿 run_shell + git 的
// 心智模型去套一个「zip 快照」目录。这条把边界讲清楚，并**指向真的可用的工具**：
// 内置 GitHub MCP 的只读工具（github_list_commits / github_get_file_contents 等）在
// riskGate 白名单里是**直接放行**的，配了凭据就能查远端——不需要 git 二进制，
// 也不需要网络白名单。
//
// 注入条件：只在「有文件工具」（read/write 模式）时给——ask 模式连文件都读不到，
// 讲了只是噪音。与其它 hint 同款纪律：说了必须有对应的读工具可用。
//
// ⚠️ 纪律（被测试当场抓过两次）：**不许点名没注册的工具**。
// 初版把 github_list_commits / github_get_file_contents 写死在文案里，于是在
// 「没配 GitHub / 没注册 MCP」的会话里提示词照样承诺这两个工具；改完后仍因写了
// `run_shell` 而被同一条测试拦住——「不要在 X 里做 Y」这种否定句同样是在**点名**，
// 没注册时它照样把模型的注意力引向一个不存在的工具。现在基础段一个工具名都不提。
// 拆成两段：基础段常驻（只讲 repos/ 是什么、以及 git 的 fetch/pull 走不通），
// 工具段仅当注册表里真的出现 `github_` 前缀工具时才追加。
const REPO_SNAPSHOT_BASE_HINT = 'repos/ 下是**分支快照**（从 GitHub 打包下载解压的），不含 .git 历史；'
  + '本环境没有 git 二进制，git 的 fetch / pull / clone 走不通，不要朝这个方向尝试。';

const REPO_SNAPSHOT_GITHUB_HINT = ' 要了解远端最新状态或与本地对不上时，用 GitHub 的只读工具：'
  + 'github_list_commits 看分支最新提交、github_get_file_contents 直接取远端文件；'
  + '拉取时记录的分支 HEAD 提交号在 .easychat/pull-manifest.json 里，可据此说明本地落后多少。';

export const REPO_SNAPSHOT_HINT = REPO_SNAPSHOT_BASE_HINT;

// 依据**真实注册表**决定要不要提 GitHub 工具（见上方的纪律说明）。
export function repoSnapshotHint(tools) {
  const names = Array.isArray(tools) ? tools : [];
  const hasGithubTools = names.some(name => typeof name === 'string' && name.startsWith('github_'));
  return hasGithubTools ? `${REPO_SNAPSHOT_BASE_HINT}${REPO_SNAPSHOT_GITHUB_HINT}` : REPO_SNAPSHOT_BASE_HINT;
}

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
export function buildWorkspaceAgentSystemPrompt({ mode = 'ask', characterName = '', tools, memory, skills, readLog, agents, teams, hookText } = {}) {
  const lines = [WORKSPACE_AGENT_BASE_PROMPT];
  // FEAT-AC4 P1：世界观边界（静态，永远成立）——治「问发动态却去 grep src」。
  lines.push(APP_FEATURE_BOUNDARY_PROMPT);
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
    // 团队清单——只在 run_team 真注册时注入（同款纪律）。
    if (Array.isArray(tools) && tools.includes('run_team')) {
      const teamsSection = workspaceTeamsSection(teams);
      if (teamsSection) lines.push(teamsSection);
    }
    // A3：计划工具引导——工具没注册就不提（说了调不动，模型会反复试然后乱解释）。
    if (Array.isArray(tools) && tools.includes('update_plan')) lines.push(PLAN_TOOL_HINT);
    // repos/ 快照语义（2026-10-18）：有文件工具才讲（ask 模式读不到文件，讲了是噪音）。
    // 按真实注册表决定要不要提 GitHub 工具（见 repoSnapshotHint 的纪律说明）。
    lines.push(repoSnapshotHint(tools));
    // FEAT-AC4 P1：应用工具段（按实际注册清单组装，一个都没有时不写）。
    const appSection = appFeatureToolSection(tools);
    if (appSection) lines.push(appSection);
  }
  lines.push(workspaceAgentModeHint(mode));
  if (mode === 'write') {
    lines.push(...workspaceExecutionToolHints(tools));
    // C2：物化引导（只在工具真注册时注入——同款纪律）。
    if (Array.isArray(tools) && tools.includes('materialize_repo')) lines.push(MATERIALIZE_TOOL_HINT);
  }
  // P0-8：hooks.json 的 before_prompt / session_start / after_turn 注入文字。放在 readLog
  // **之前**——readLog 是每轮都变的高频动态项，必须留在最末尾（上面的缓存契约）。
  const hookSection = String(hookText || '').trim();
  if (hookSection) lines.push(`[工作区钩子]\n${hookSection}`);
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
// P5：展开 toolTrace（tool 结果 / assistant(tool_calls)），让 agent 看到跨轮的工具结果。
export function projectWorkspaceChatHistory(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const projected = [];
  for (const item of list) {
    if (!item) continue;
    if (item.role === 'tool') {
      projected.push({ role: 'tool', tool_call_id: item.tool_call_id, content: String(item.content || '') });
      continue;
    }
    if (item.role === 'assistant' && Array.isArray(item.tool_calls) && item.tool_calls.length) {
      projected.push({
        role: 'assistant',
        content: item.content == null ? null : String(item.content),
        tool_calls: item.tool_calls,
      });
      continue;
    }
    if (item.role !== 'user' && item.role !== 'assistant') continue;
    if (Array.isArray(item.toolTrace) && item.toolTrace.length) {
      for (const traceItem of item.toolTrace) projected.push(traceItem);
    }
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

// 解析「这一轮到底发什么文本」。
//
// **只认字符串**：`onPress={handleSend}` 会把 React Native 的**点击事件对象**当第一个实参
// 传进来（那是 RN 的约定，不是调用方写错）。若按「不是 undefined 就用它」判断，
// `String(事件对象)` 恰好是 `"[object Object]"`——表现就是**工作区里发什么都变成
// [object Object]**。事件对象不是文本，一律回落到输入框。
// 计划批准链路（I2）传的是真字符串，照常生效。
export function resolveSendText(overrideText, input) {
  const source = typeof overrideText === 'string' ? overrideText : input;
  return String(source == null ? '' : source).trim();
}
