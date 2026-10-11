// 主动消息「随机时段 + 风格权重」的纯逻辑（零 React / 零 RN，Node 直测）。
//
// 与视图分开的理由很实际：编辑器是 RN 组件，Node 里 import 不了 react-native，
// 时段换算与权重换算这些**会算错的地方**就完全没法测。放这里之后它们是普通纯函数。
//
// 两条约束只在这里收口：
//   时段 —— 0 = 准点发（旧行为）；>0 = 起始时刻之后 N 分钟内随机挑一个时刻。
//   权重 —— 存储里是比例（正权重之和 = 1，由 storage/moments.js 归一）；
//            界面按整数百分比显示与编辑，整数之间往返无损，所以编辑时数字不会跳。

// 随机时段的可选长度（分钟）。0 = 关闭随机（准点发）。
export const PROACTIVE_WINDOW_OPTIONS = [0, 30, 60, 120, 180, 360];

// 权重上限（百分比）。超过 100 没有意义——归一之后都一样。
export const WEIGHT_MAX_PERCENT = 100;

// 存储里的权重（比例）→ 界面上的整数百分比。
export function weightToPercent(weight) {
  const num = Number(weight);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return Math.min(Math.round(num * 100), WEIGHT_MAX_PERCENT);
}

// 界面上的整数百分比 → 存进槽位的权重（比例）。**不在这里归一**：
// 归一由存储层统一做（它才知道整张表），界面自己归一会让用户每敲一个字符数字就跳。
export function percentToWeight(percent) {
  const num = Math.trunc(Number(percent));
  if (!Number.isFinite(num) || num <= 0) return 0;
  return Math.min(num, WEIGHT_MAX_PERCENT) / 100;
}

// 时段 → 可读区间。跨午夜（如 22:00 + 6h）时标出「次日」——否则用户看到
// 「22:00 – 04:00」会以为配置错了。windowMinutes=0（关闭）返回 null。
export function formatWindowRange(hour, minute, windowMinutes) {
  const span = Math.max(0, Math.trunc(Number(windowMinutes) || 0));
  if (span <= 0) return null;
  const start = (Number(hour) || 0) * 60 + (Number(minute) || 0);
  const end = start + span;
  const pad = value => String(value).padStart(2, '0');
  const clock = total => `${pad(Math.floor((total % 1440) / 60))}:${pad(total % 60)}`;
  return { start: clock(start), end: clock(end), nextDay: end >= 1440 };
}

// 槽位的 styles → 「每种类型一行」的界面模型（类型集合固定为四种，缺的按 0 显示）。
export function buildStyleRows(slot, messageTypes) {
  const byType = new Map(
    (Array.isArray(slot && slot.styles) ? slot.styles : [])
      .filter(item => item && typeof item === 'object')
      .map(item => [item.messageType, item]),
  );
  return (Array.isArray(messageTypes) ? messageTypes : []).map(type => {
    const item = byType.get(type);
    return {
      type,
      percent: item ? weightToPercent(item.weight) : 0,
      customPrompt: item ? String(item.customPrompt || '') : '',
    };
  });
}

// 一行的权重在「启用行」里占多少（界面上显示成 ≈N%）。全为 0 时返回 0，
// 由调用方给出「全部为 0 会退回第一条」的提示。
export function effectivePercent(percent, activeTotal) {
  const total = Number(activeTotal);
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.round((Number(percent) || 0) / total * 100);
}

// 界面行 → 槽位的 styles。0 权重的行也写回：用户把某条调到 0 只是暂时停用，
// 不该顺手抹掉他填过的自定义提示词（存储层同样保留 0 权重条目）。
export function styleRowsToStyles(rows) {
  return (Array.isArray(rows) ? rows : []).map(row => ({
    messageType: row.type,
    customPrompt: String(row.customPrompt || ''),
    weight: percentToWeight(row.percent),
  }));
}
