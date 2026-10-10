// K1（旧工具结果退役）的**字符**预算：模型声明的窗口 → token 阈值 → 字符。
//
// 为什么单独成模块：`onlineRequestContext.js` 要碰存储层（`storage/apiConfigs.js`），
// 那条链会拖进 `expo-file-system`，在 Node 里加载不了；而预算换算本身是纯的，
// 拆出来才能直测——它正是「K1 到底会不会触发」的那个数。

import { resolveContextBudgetBytes } from '../agent/resultClearing.js';
import { resolveAutoCompactPolicy } from './compactionPolicy.js';

// 口径：`compactionPolicy`（全仓唯一阈值来源）给 token 阈值，`resultClearing` 按
// **本次消息自己**的字符/token 比换算成字符（不写死常数，中英文各按自己的比值）。
//
// 为什么必须接通：K1 的默认预算 2MB 是照「4MB 落库会话阈值的一半」定的，可它量的是
// **本次请求**的 history——请求上限是模型窗口（200k token 的中文 ≈ 0.4MB 字符），
// 2MB 永远够不到，于是 K1 在生产里一次都不触发（实测：堆到 856k token 也只占预算 41%，
// 清除 0 条）。
//
// 未声明窗口（0 / 非数）→ 返回 0，调用方据此**不传**该选项 = 保持 K1 的 2MB 默认，
// 行为与接通前逐字一致。
export function resolveAgentContextBudget(messages, contextWindow) {
  const thresholdTokens = resolveAutoCompactPolicy({
    contextWindow: Number(contextWindow) || 0,
  }).thresholdTokens;
  return resolveContextBudgetBytes(messages, { thresholdTokens });
}
