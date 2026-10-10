// 工作区上下文占用的**唯一口径**（W3③）。
//
// 为什么要有它：此前两处各算一套——ChatPanel 按工作区会话历史算，FilesPanel 按该角色的
// 最近一个**单聊**会话算。同一个标签（「上下文占用」）两种数据源：用户在两处看到的数字会
// 互相打架，而 FilesPanel 那份算的根本不是工作区要发出去的历史（工作区 agent 发的是
// workspaceChats 里的那份）。现在只留这一个函数，两处都调它。
//
// 口径与 ChatScreen.maybeAutoSummarize 一致（chat/contextUsage.js）：窗口取模型声明 >
// 本地模型 n_ctx > 兜底。失败一律返回 null（占用是观测，不该成为失败点）。

import { capabilitiesForModel, getActiveModel, getApiConfigs } from '../storage/apiConfigs.js';
import { getActiveLocalModel } from '../storage/localModels.js';
import { normalizeLocalModelParams } from '../localModel/modelParams.js';
import { getWorkspaceChats } from '../storage/workspace.js';
import { computeContextUsage, resolveContextWindow } from '../chat/contextUsage.js';

export async function loadWorkspaceContextUsage(ownerId) {
  try {
    const [{ configs, activeId }, localItem, bucket] = await Promise.all([
      getApiConfigs(),
      getActiveLocalModel().catch(() => null),
      getWorkspaceChats(ownerId).catch(() => null),
    ]);
    const active = bucket && (bucket.chats.find(item => item.id === bucket.activeId) || bucket.chats[0]);
    const list = (active && active.messages) || [];
    const current = configs.find(item => item.id === activeId) || configs[0];
    const caps = capabilitiesForModel(current, current ? getActiveModel(current) : '');
    const localContextSize = localItem ? normalizeLocalModelParams(localItem).contextSize : 0;
    const usage = computeContextUsage(list, resolveContextWindow({
      declared: caps.contextWindow,
      localContextSize,
    }));
    return usage && Number.isFinite(usage.ratio) ? usage : null;
  } catch (error) {
    return null;
  }
}
