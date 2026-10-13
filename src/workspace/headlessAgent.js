// 无头 agent 运行器（P3-8）：给本地 API 服务的 POST /v1/agent 端点用——程序化驱动
// 一轮 agent 工具循环（模型 + 工作区工具），返回结论文本与工具步骤。
//
// 复用与工作区聊天同一套组装：默认工作区角色沙盒 + 系统提示（记忆/技能/分身/团队）+ 注册表工具。
// 工具是**全局注册表**，运行前后注册/注销；端点请求经共享串行队列，不会与聊天推理并发。
//
// SW2（2026-10-13）：本运行器同时成为**看屏幕·工作区会话**的回合执行器——为此补三件事：
//   ① confirm 钩子（破坏性操作执行前弹确认；不传 = 需要确认的工具一律拒绝，见 registry 注释）；
//   ② images 多模态透传（看屏幕的帧序列要能进请求）；
//   ③ 用户主动说话与画面描述合并（复用 screenWatch 的 mergeDescriptionIntoUserText 语义）。
// 仍然**不做**写入放行：写模式必须由宿主显式 allowWrite 或传 confirm 钩子（程序化端点
// 保持默认只读，UI 侧由面板传 confirm）。

import { runAgentTurn } from '../agent/loop.js';
import { listToolsForMode } from '../agent/tools/registry.js';
import { resolveHeadlessMode } from '../agent/agentEndpoint.js';
import { getWorkspaceSettings } from '../storage/workspace.js';
import { createWorkspaceStore } from './native.js';
import { resolveWorkspaceAssistant } from './assistant.js';
import { buildWorkspaceAgentMessages, buildWorkspaceAgentSystemPrompt } from './chat.js';
import { readWorkspaceMemory } from './memory.js';
import { readWorkspaceSkills } from './skills.js';
import { readWorkspaceAgents } from './agents.js';
import { readWorkspaceTeams } from './teams.js';
import { registerWorkspaceTools } from './tools.js';

// 跑一轮 agent。返回 { text, steps, characterId, mode }。缺 prompt 且无历史 → 空结果。
// 纯函数：端点的实际运行模式。写模式必须经宿主显式 allowWrite 才生效，否则降级为 read
//（端点是程序化入口，写工具不需要逐条确认——不能让任何持 Bearer 的客户端无确认写沙盒）。
export async function runHeadlessAgent({
  prompt = '',
  messages = [],
  mode = 'read',
  maxRounds = 0,
  characterId = '',
  signal = null,
  // 端点是程序化入口：默认只读。请求里的 mode:'write' 必须经宿主显式 allowWrite 才生效，
  // 否则降级为 read——避免任何持 Bearer 的本机客户端无确认写沙盒（写工具不需要逐条确认）。
  allowWrite = false,
  // SW2：宿主确认钩子（看屏幕工作区会话注入；不传 = 需要确认的工具被拒，见 registry）。
  confirm = null,
  // SW2：权限规则源（hooks.json + 用户存储规则）——与工作区聊天同一条合并入口。
  // 不传时「写工具上手写 deny 会变死键」（见 toolApprovalFlow 的 P0-2 注释）。
  permissionRules = null,
  // SW2：多模态帧（data: URI 数组）——看屏幕把当前画面交给模型。
  images = [],
  // SW2：工具事件回调（面板显示「正在调用 X」；缺省不订阅）。
  onToolEvent = null,
} = {}) {
  const effectiveMode = resolveHeadlessMode(mode, allowWrite);
  const text = String(prompt || '').trim();
  const history = (Array.isArray(messages) ? messages : [])
    .filter(item => item && (item.role === 'user' || item.role === 'assistant') && typeof item.content === 'string')
    .map(item => ({ role: item.role, content: item.content }));
  if (!text && history.length === 0) return { text: '', steps: [], mode: effectiveMode, characterId };

  const settings = await getWorkspaceSettings();
  const store = createWorkspaceStore(settings);
  const resolved = await resolveWorkspaceAssistant(characterId).catch(() => null);
  const character = resolved && resolved.character;
  const ownerId = String((character && character.id) || characterId || '');
  const characterName = String((character && character.name) || '');

  registerWorkspaceTools({ store });
  const steps = [];
  try {
    const tools = listToolsForMode(effectiveMode).map(item => item.function.name);
    const memory = await readWorkspaceMemory(store, ownerId).catch(() => '');
    const skills = effectiveMode === 'ask' ? [] : await readWorkspaceSkills(store, ownerId).catch(() => []);
    const agents = effectiveMode === 'ask' ? [] : await readWorkspaceAgents(store, ownerId).catch(() => []);
    const teams = effectiveMode === 'ask' ? [] : await readWorkspaceTeams(store, ownerId).catch(() => []);
    const systemPrompt = buildWorkspaceAgentSystemPrompt({ mode: effectiveMode, characterName, tools, memory, skills, agents, teams });
    // SW2：帧走 buildWorkspaceAgentMessages 的 images 口径（结构化 image_url 内容块，
    // 与工作区聊天同一条构造）——不自己拼消息形状，避免两处格式漂移。
    const frames = (Array.isArray(images) ? images : []).map(item => String(item || '')).filter(Boolean);
    const request = buildWorkspaceAgentMessages({
      systemPrompt,
      history,
      userText: text,
      images: frames,
    });
    const result = await runAgentTurn(request, {
      mode: effectiveMode,
      ...(maxRounds > 0 ? { maxRounds } : {}),
      signal,
      context: { characterId: ownerId },
      // SW2：确认钩子只在宿主给了才传——不传时需要确认的工具按「问不到 = 不执行」被拒
      //（这是 registry 的既定纪律，绝不在无 UI 场景默默放行）。
      ...(typeof confirm === 'function' ? { onToolApproval: confirm } : {}),
      // 权限规则同样只在给了才传（缺省 = 无规则，行为与旧版一致）。
      ...(permissionRules ? { permissionRules } : {}),
      onToolEvent: event => {
        if (event && event.phase === 'start' && event.name) steps.push({ name: event.name });
        if (typeof onToolEvent === 'function') onToolEvent(event);
      },
    });
    const output = typeof result === 'string' ? result : String((result && result.text) || '');
    return { text: output, steps, mode: effectiveMode, characterId: ownerId };
  } finally {
    // 全局注册表是共享单例（工作区聊天也用它）：**不注销**——注销会把 UI 已注册的同名工具
    // 一并清空，留下「注册表为空」的窗口。保留注册即可；UI 每次发送前都会重新注册（useChatSend）。
    // （端点与 UI 的 store 都指向工作区助手沙盒，正常情况下一致。）
  }
}
