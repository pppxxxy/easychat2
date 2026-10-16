// FEAT-AC12：工作区「对话」回合的**请求装配**（从 ChatPanel 外提）。
//
// 为什么外提：
//   ① **行数棘轮**——ChatPanel 卡在基线上，本轮要给发送链路加同步闸门（P0-2），
//      按仓库纪律「拆文件，不抬上限」，所以把这段装配逻辑搬出来腾空间；
//   ② **可测性**——这段是纯装配（读几份上下文 → 拼系统提示 → 拼消息 → 裁媒体），
//      此前埋在 1600 行的组件里，只能靠源码正则断言（那种断言会空转）。
//
// 搬移原则：**逐字搬运、行为不变**。所有依赖由调用方注入（store / 角色 / 历史 /
// 工具顺序引用），本模块不碰任何 React 状态，也不读全局单例——
// 这样它既能被 ChatPanel 调用，也能在 Node 里直接断言。

import { registerWorkspaceAgentTools } from '../agentToolSetup.js';
import { saveSessionPlan } from '../../storage/sessionPlan.js';
import { readWorkspaceMemory } from '../memory.js';
import { readWorkspaceSkills } from '../skills.js';
import { readWorkspaceAgents } from '../agents.js';
import { readWorkspaceTeams } from '../teams.js';
import {
  buildWorkspaceAgentMessages,
  buildWorkspaceAgentSystemPrompt,
  projectWorkspaceChatHistory,
} from '../chat.js';
import { getCharacterApiConfigs } from '../../character/runtimeConfig.js';
import { filterRequestMedia } from '../../prompt/chatPipeline.js';

/**
 * 装配一轮工作区对话请求。
 *
 * @param {object} args
 * @param {object} args.store 工作区 store（读 AGENTS.md / 技能 / 分身 / 团队）
 * @param {string} args.characterId 角色 id（专属 API 配置解析用）
 * @param {string} args.ownerId 会话归属 id（沙盒目录用）
 * @param {string} args.mode 工作模式（ask/read/write）
 * @param {string} args.characterName 角色名（进系统提示）
 * @param {Array} args.history 会话消息
 * @param {string} args.outgoingText 本轮用户输入（斜杠命令已展开）
 * @param {Array} args.images 图片 data URI
 * @param {string} args.hookText hooks.json 注入文本
 * @param {object} args.readLog 本会话已读登记（可空）
 * @param {object} args.toolOrder 工具顺序签名表（**会被就地更新**，见下）
 * @param {object} args.settings 工作区设置快照
 * @param {Function} args.materializer 按需物化函数（可空）
 * @param {string} args.chatId 会话 id（计划落盘用）
 * @returns {Promise<{tools: Array, request: object, chatRuntime: object}>}
 */
export async function assembleWorkspaceTurn({
  store,
  characterId,
  ownerId,
  mode,
  characterName,
  history,
  outgoingText,
  images,
  hookText = '',
  readLog = null,
  toolOrder = null,
  settings = null,
  materializer = null,
  chatId = '',
} = {}) {
  // 先注册工具、再拼提示词（顺序契约与漂移判据见 agentToolSetup.js 的注释）。
  let tools = [];
  if (mode !== 'ask') {
    try {
      const setup = await registerWorkspaceAgentTools({
        settings, mode,
        readLog, materializer,
        // W3②：计划随会话落盘（此前只存在内存里，切面板/切会话就丢）。
        onPlan: steps => saveSessionPlan(chatId, steps),
        previous: toolOrder,
      });
      tools = setup.tools;
      // E1：顺序漂移 = 前缀缓存全 miss。开发期告警、生产静默；mode 切换不算漂移。
      if (setup.drifted && typeof __DEV__ !== 'undefined' && __DEV__) {
        console.warn('[cache] 工具顺序在会话内发生变化（会打碎前缀缓存）：', setup.prevSignature, '→', setup.signature);
      }
      if (toolOrder) toolOrder[mode] = setup.signature;
    } catch (error) {}
  }

  // 工作区记忆（AGENTS.md）：每轮直读、不缓存——agent 可能刚在上一轮里改过它
  //（自我演进通路），缓存一旦判断失误模型就会按旧指令工作；读失败当没有，不打扰聊天。
  const memory = await readWorkspaceMemory(store, ownerId);
  // 技能清单（渐进披露第一层）：同样每轮直读——技能目录不存在时只有一次 list IO。
  const skills = mode === 'ask' ? [] : await readWorkspaceSkills(store, ownerId);
  // E3：分身档案清单（渐进披露第一层）——同样每轮直读；run_subagent 没注册时
  // 提示词自动不注入（buildWorkspaceAgentSystemPrompt 内部判据）。
  const agents = mode === 'ask' ? [] : await readWorkspaceAgents(store, ownerId);
  // 团队清单（持久化团队）：同样每轮直读；run_team 没注册时提示词自动不注入。
  const teams = mode === 'ask' ? [] : await readWorkspaceTeams(store, ownerId);
  const systemPrompt = buildWorkspaceAgentSystemPrompt({
    mode,
    characterName,
    tools: tools.map(item => item.function.name),
    memory,
    skills,
    agents,
    teams,
    // A5：本会话已读清单（本轮注入的 read 结果里，上一轮读过的会出现在这行）。
    readLog: readLog ? readLog.list() : [],
    // P0-8：hooks.json 的注入类事件（放在 readLog 之前，见该函数的缓存契约）。
    hookText,
  });
  let request = buildWorkspaceAgentMessages({
    systemPrompt,
    history: projectWorkspaceChatHistory(history),
    // 斜杠命令在这里生效：outgoingText = 用户输入原文，或命令展开后的文本。
    userText: outgoingText,
    images,
  });
  // 工作区对话同样走角色专属聊天 API：activeId 已按角色覆盖解析，专属模型也写进了
  // 该条配置的 activeModel，故下面的媒体裁剪按专属口径。chatRequestOptions 只在
  // 专属配置生效时非空（无覆盖时 = 既有「按全局激活项解析」路径）。
  const chatRuntime = await getCharacterApiConfigs(characterId)
    .catch(() => ({ configs: [], activeId: '', chatRequestOptions: {} }));
  const cfg = chatRuntime.configs.find(item => item.id === chatRuntime.activeId) || chatRuntime.configs[0] || null;
  request = filterRequestMedia(request, { allowVision: Boolean(cfg && cfg.supportsVision), allowAudio: false });

  return { tools, request, chatRuntime };
}
