// 批量删除消息的「计划」计算（桌面）：纯逻辑，Node 直测。
//
// 为什么单独成模块：删消息不只是 removeMessagesByIds——手机侧还串了四件事，
// 顺序错了会留下不一致状态：
//   ① 记忆摘要失效（`summarizeBoundaryAfterDeletion` 重算边界）；
//   ② 被删的是「连续尾段」时，先归档成分支（否则整段删除后无法回溯）；
//   ③ 删光全部消息 ≡ 旧「清空」：额外重置开场白选择、整段清向量索引；
//   ④ 否则按消息 id 逐条清向量索引。
// 这里把「该做哪几件」算成一个可断言的计划对象，界面只负责按计划执行。
import { getContinuousTailPlan, removeMessagesByIds } from '../../../src/chat/messageSelection.js';

export function planMessageDeletion(messages, messageIds) {
  const list = Array.isArray(messages) ? messages : [];
  const ids = (Array.isArray(messageIds) ? messageIds : [messageIds])
    .map(id => String(id || ''))
    .filter(Boolean);
  if (ids.length === 0) return null;
  // 空时间线没有可删的东西：返回 null 让调用方完全不动作
  //（否则会算出 clearsAll=false 的「按 id 清向量」计划，白跑一趟清理）。
  if (list.length === 0) return null;
  const remaining = removeMessagesByIds(list, ids);
  // 删光 = 与旧「清空」同义（手机侧据此重置开场白选择并整段清向量）。
  const clearsAll = list.length > 0 && remaining.length === 0;
  // 连续尾段：归档成分支，让「全选 + 删除」仍可回溯。
  const tailPlan = getContinuousTailPlan(list, ids);
  return {
    ids,
    remaining,
    clearsAll,
    // 只在真的删到队尾时归档（tailPlan 为空表示不是连续尾段，不建分支）。
    archive: tailPlan && tailPlan.tail.length > 0
      ? { forkMessageId: tailPlan.forkMessageId, messages: tailPlan.tail }
      : null,
    // 向量清理口径：整段清 vs 按 id 清。
    vector: clearsAll ? { mode: 'session' } : { mode: 'messages', ids },
  };
}

// 确认弹窗的文案选择：删光比普通删除更需要说明影响面（手机同一口径）。
export function deletionConfirmBodyKey(plan) {
  return plan && plan.clearsAll ? 'chat.deleteMessages.allBody' : 'chat.deleteMessages.body';
}