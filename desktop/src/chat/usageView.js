// 桌面聊天页的上下文占用视图（纯函数，Node 直测）。
//
// 口径全部来自共享层，不在这里另写阈值：
//   · token 估算 / 窗口解析：src/chat/contextUsage.js
//   · 压缩阈值与「建议压缩」派生线：src/chat/compactionPolicy.js（全仓唯一来源）
// 本模块只做「把数字变成可显示的档位」——这样占用条、提示条、颜色都同源，
// 不会出现「条说 40%、提示条说该压了」这种互相打架的界面。
import { computeContextUsage, resolveContextWindow } from '../../../src/chat/contextUsage.js';
import {
  resolveAutoCompactPolicy,
  resolveCompactHintTokens,
} from '../../../src/chat/compactionPolicy.js';

// 空态：没有会话或无消息时用同一形状，渲染层不必判空两次。
export const EMPTY_USAGE = Object.freeze({ tokens: 0, window: 0, ratio: 0, maxOutput: 0 });

// 由消息数组 + 当前模型能力算占用。declared/localContextSize/model 与 Android ChatScreen
// 的 resolveContextWindow 入参逐字一致（声明窗口 > 本地模型 n_ctx > 模型家族建议 > 默认）。
export function usageFromMessages(messages, {
  declared = 0,
  localContextSize = 0,
  model = '',
  maxOutput = 0,
} = {}) {
  const window = resolveContextWindow({ declared, localContextSize, model });
  const usage = computeContextUsage(Array.isArray(messages) ? messages : [], window);
  const output = Number(maxOutput);
  return {
    tokens: Math.max(0, Number(usage.tokens) || 0),
    window: Math.max(0, Number(usage.window) || 0),
    ratio: Math.max(0, Number(usage.ratio) || 0),
    maxOutput: Number.isFinite(output) && output > 0 ? Math.floor(output) : 0,
  };
}

// 两个阈值：自动压缩线（到达即应压缩）与提示线（先于自动线出现）。
export function usageThresholds(usage) {
  const policy = resolveAutoCompactPolicy({
    contextWindow: usage && usage.window,
    maxOutputTokens: usage && usage.maxOutput,
  });
  return {
    autoTokens: policy.thresholdTokens,
    hintTokens: resolveCompactHintTokens(policy),
    policy,
  };
}

// 三档：normal（低于提示线）/ high（过提示线，未到自动线）/ critical（到自动线）。
// 桌面首版不做静默自动压缩，critical 只用于把提示条转成警示色并强制显示。
export function usageLevel(usage, thresholds) {
  const tokens = Math.max(0, Number(usage && usage.tokens) || 0);
  const hint = Math.max(0, Number(thresholds && thresholds.hintTokens) || 0);
  const auto = Math.max(0, Number(thresholds && thresholds.autoTokens) || 0);
  if (hint > 0 && tokens >= hint) return auto > 0 && tokens >= auto ? 'critical' : 'high';
  return 'normal';
}

// 百分比：四舍五入到整数；窗口未知时返回 0（不编假数字，与 buildContextBreakdown 同纪律）。
export function usagePercent(usage) {
  const window = Number(usage && usage.window);
  const tokens = Number(usage && usage.tokens);
  if (!Number.isFinite(window) || window <= 0) return 0;
  if (!Number.isFinite(tokens) || tokens <= 0) return 0;
  return Math.max(0, Math.round((tokens / window) * 100));
}

// 紧凑的 token 数字：9500 / 12.3k / 128k。只影响显示，不参与任何判定。
export function formatTokenCount(value) {
  const tokens = Math.max(0, Math.trunc(Number(value) || 0));
  if (tokens < 1000) return String(tokens);
  if (tokens < 100000) {
    const k = tokens / 1000;
    return `${k >= 100 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, '')}k`;
  }
  return `${Math.round(tokens / 1000)}k`;
}

// 「建议压缩」提示条该不该出现：占用达到提示线、用户这次没点忽略、且还有历史可压
// （只有一条开场白时提示毫无意义，压缩也必然 noop）。
export function shouldShowCompactHint(usage, thresholds, { dismissed = false, meaningfulMessages = 0 } = {}) {
  if (dismissed) return false;
  if (Number(meaningfulMessages) <= 0) return false;
  return usageLevel(usage, thresholds) !== 'normal';
}