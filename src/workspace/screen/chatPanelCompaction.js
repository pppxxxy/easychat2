// FEAT-AC12：工作区会话压缩的**执行逻辑**（从 ChatPanel 外提）。
//
// 为什么外提：
//   ① **行数棘轮**——ChatPanel 卡在基线上，本轮要给发送链路加同步闸门（P0-2），
//      按仓库纪律「拆文件，不抬上限」，所以把这段搬出来腾空间；
//   ② **可测性**——这段是「读配置 → 定阈值 → 跑管线 → 落盘」，全是可注入依赖，
//      此前埋在 1700 行组件里只能靠源码正则断言（那种断言会空转）。
//
// 搬移原则：**逐字搬运、行为不变**。所有依赖由调用方注入（store / 会话 id / 消息），
// 本模块不碰 React 状态。
//
// 四档管线（N2）：展示历史里没有 tool 消息，L0/L1 自然空转，实际走 L2 摘要 + L3 归档
// ——即「摘要旧史 + 保留尾部」。silent=true 时按 compactionPolicy 阈值自判
//（每轮自动调用）；手动时 autoRatio=0 强制压缩。失败一律不改会话（压缩是增强）。

import { capabilitiesForModel, getActiveModel, getApiConfigs } from '../../storage/apiConfigs.js';
import { getActiveLocalModel } from '../../storage/localModels.js';
import { AUTO_COMPACT_RATIO, resolveContextWindow } from '../../chat/contextUsage.js';
import { resolveAutoCompactPolicy } from '../../chat/compactionPolicy.js';
import { runCompactionPipeline } from '../../chat/compactionPipeline.js';
import { buildSessionCompactionDeps } from '../../chat/sessionCompaction.js';
import { getConfigFingerprint, sendChatMessage } from '../../network/api.js';

/**
 * 跑一次工作区会话压缩。
 *
 * @param {object} args
 * @param {Array} args.list 参与压缩的消息（**不是**从 store 读——调用方决定口径）
 * @param {boolean} args.silent true = 按策略阈值自判（每轮自动）；false = 强制压缩（手动）
 * @param {object} args.store 工作区 store（transcript 落盘用）
 * @param {string} args.characterId 角色 id
 * @returns {Promise<{ok: boolean, reason?: string, applied?: Array, messages?: Array}>}
 *   ok:true 时调用方负责 setMessages + 落盘（本函数不碰 UI/存储的会话写入）。
 */
export async function runWorkspaceCompaction({ list, silent = false, store, characterId } = {}) {
  const messages = Array.isArray(list) ? list : [];
  if (messages.length < 2) return { ok: false, reason: 'too-short' };
  try {
    const [{ configs, activeId }, localItem] = await Promise.all([
      getApiConfigs(),
      getActiveLocalModel().catch(() => null),
    ]);
    const current = configs.find(item => item.id === activeId) || configs[0];
    if (!current) return { ok: false, reason: 'failed' };
    const model = getActiveModel(current);
    const caps = capabilitiesForModel(current, model);
    const localContextSize = Number(localItem && localItem.contextSize) || 0;
    const windowSize = resolveContextWindow({ declared: caps.contextWindow, localContextSize, model });
    // 阈值统一走 compactionPolicy（Z 系采纳 #5：模型感知 + 输出预留 + 缓冲）。
    const policy = resolveAutoCompactPolicy({ contextWindow: windowSize });
    const autoRatio = windowSize > 0 ? policy.thresholdTokens / windowSize : AUTO_COMPACT_RATIO;
    // deps 换用 Z 线自己写的 buildSessionCompactionDeps（P1-7）：原先这里**内联**了一份
    // 五项装配（estimateRatio / summarize / writeTranscript / retainTokens / estimateTokens），
    // 与那个函数逐字相同——两份近似代码的下场必然是「只改一处」（本次合并里
    // estimateTokens 的正文口径、minMessages 的键名就都踩过）。宿主侧装配只留一处。
    const result = await runCompactionPipeline(messages, {
      autoRatio: silent ? autoRatio : 0,
      deps: buildSessionCompactionDeps({
        windowSize,
        store,
        characterId,
        summarize: request => sendChatMessage(request, {
          stream: false,
          expectedConfigId: String(current.id || ''),
          expectedConfigFingerprint: getConfigFingerprint(current),
        }),
      }),
    });
    if (result.applied.length > 0 && result.messages !== messages) {
      return { ok: true, applied: result.applied, messages: result.messages };
    }
    return { ok: false, reason: 'noop' };
  } catch (error) {
    return { ok: false, reason: 'failed' };
  }
}
