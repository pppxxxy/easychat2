import { useCallback } from 'react';

import { EMPTY_REPLY_TEXT, getConfigFingerprint, sendChatMessage } from '../network/api.js';
import { buildSystemPrompt } from '../character/cardParser.js';
import { buildRequestMessages } from '../prompt/chatPipeline.js';
import { getLocalModelMediaCapabilities } from '../localModel/modelState.js';
import { getActiveLocalModel, getLocalModelSettings } from '../storage/localModels.js';
import { getActiveModel, capabilitiesForModel, getApiConfigs } from '../storage/apiConfigs.js';
import {
  buildJsonRepairPrompt,
  draftToCharacterPatch,
  FIELD_ASSIST_SYSTEM,
  FORGE_SAMPLING_OVERRIDES,
  FORGE_SYSTEM,
  parseCardPatch,
} from './forge.js';

// 制卡页与模型的交互：整卡问答生成、单字段辅助、模拟对话、当前模型名与识图能力。
// 从 CardForgeScreen 原样搬出（行为不变），只依赖 t（用于空回复提示文案）。
export default function useForgeRequests(t) {
  const askModel = useCallback(async (prompt, signal) => {
    const { configs, activeId } = await getApiConfigs();
    const current = configs.find(item => item.id === activeId) || configs[0];
    const request = userPrompt => sendChatMessage([
      { role: 'system', content: FORGE_SYSTEM },
      { role: 'user', content: userPrompt },
    ], {
      stream: false,
      signal,
      expectedConfigId: String(current && current.id || ''),
      expectedConfigFingerprint: current ? getConfigFingerprint(current) : '',
      overrides: FORGE_SAMPLING_OVERRIDES,
    });
    const raw = await request(prompt);
    const patch = parseCardPatch(raw);
    if (patch) return patch;
    // 解析失败多为 JSON 被截断或含非法转义：回传开头片段自修复重试 1 次。
    const repaired = await request(buildJsonRepairPrompt(raw));
    return parseCardPatch(repaired);
  }, []);

  // 单字段辅助生成：编辑器组装好的提示词直接发模型，返回原始文本
  //（不经过 parseCardPatch——这不是 JSON 协议，而是单字段纯文本改写）。
  const sendAssistPrompt = useCallback(async (prompt, signal) => {
    const { configs, activeId } = await getApiConfigs();
    const current = configs.find(item => item.id === activeId) || configs[0];
    const raw = await sendChatMessage([
      { role: 'system', content: FIELD_ASSIST_SYSTEM },
      { role: 'user', content: prompt },
    ], {
      stream: false,
      signal,
      expectedConfigId: String(current && current.id || ''),
      expectedConfigFingerprint: current ? getConfigFingerprint(current) : '',
      overrides: FORGE_SAMPLING_OVERRIDES,
    });
    // 空回复会被 api 层替换成占位文案，直接写回会把「没有收到回复。」当成模型内容
    // 塞进字段/标签。这里按生成失败抛出，让编辑器统一提示重试。
    const text = String(raw == null ? '' : raw).trim();
    if (!text || text === EMPTY_REPLY_TEXT) {
      throw new Error(t('forge.screen.error.emptyAiReply'));
    }
    return raw;
  }, [t]);

  // 制卡预览的模拟对话：把当前草稿组装成角色结构，走真实聊天管道请求模型。
  // 纯内存测试——不写会话、不落草稿、不影响角色库。
  const simulateChat = useCallback(async ({ draft: source, historyMessages, userText, signal }) => {
    const draft = source && typeof source === 'object' ? source : {};
    const { configs, activeId } = await getApiConfigs();
    const current = configs.find(item => item.id === activeId) || configs[0];
    const composedPrompt = buildSystemPrompt({
      description: draft.description,
      personality: draft.personality,
      scenario: draft.scenario,
      systemPrompt: draft.systemPrompt || '',
      postHistoryInstructions: draft.postHistoryInstructions,
    });
    const character = draftToCharacterPatch(draft, { composedPrompt });
    const messages = buildRequestMessages({ character, historyMessages, userText });
    return sendChatMessage(messages, {
      stream: false,
      signal,
      expectedConfigId: String(current && current.id || ''),
      expectedConfigFingerprint: current ? getConfigFingerprint(current) : '',
    });
  }, []);

  // 与 askModel 同源的模型选择：aigcMeta 里记录实际使用的模型名。
  // 必须用 storage.getActiveModel 的同一口径（activeModel → models[0] → model），
  // 否则实际请求的模型与记录进 aigcMeta 的模型名会对不上。
  const activeForgeModel = useCallback(async () => {
    const { configs, activeId } = await getApiConfigs();
    const current = configs.find(item => item.id === activeId) || configs[0];
    return getActiveModel(current);
  }, []);

  // 当前来源是否具备识图能力：在线 supportsVision 或本地模型多模态（与聊天附件、
  // 看屏幕同一口径）。制卡「按图片生成」需要它来决定是否把图片真的发给模型。
  const activeForgeVision = useCallback(async () => {
    const [{ configs, activeId }, localSettings, localItem] = await Promise.all([
      getApiConfigs(),
      getLocalModelSettings().catch(() => null),
      getActiveLocalModel().catch(() => null),
    ]);
    const current = configs.find(item => item.id === activeId) || configs[0];
    const localMedia = getLocalModelMediaCapabilities(localSettings, localItem);
    // 能力按当前模型解析（同一配置下每个模型一套能力）。
    return capabilitiesForModel(current, current ? getActiveModel(current) : '').supportsVision === true
      || localMedia.vision;
  }, []);

  return { askModel, sendAssistPrompt, simulateChat, activeForgeModel, activeForgeVision };
}
