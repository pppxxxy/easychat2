// 主动消息槽位的纯判定（零依赖叶子，Node 与渲染层都能直接引用）。
//
// 从 useProactiveForeground 抽出：那个 hook 还 import 存储与网络（会拖进
// expo-file-system），而这两条判定只依赖时间与权重，单独成文件后才能直测。
export function pickVariant(variants, random = Math.random) {
  const list = (Array.isArray(variants) ? variants : []).filter(item => item && item.weight > 0);
  if (list.length === 0) return null;
  const total = list.reduce((sum, item) => sum + item.weight, 0);
  let ticket = random() * total;
  for (const item of list) {
    ticket -= item.weight;
    if (ticket <= 0) return item;
  }
  return list[list.length - 1];
}

// 「这个槽此刻是否到点」。windowMinutes > 0 时在 [目标, 目标+窗口) 内都算到点
// （随机时段的语义：窗口内任意时刻发一次即可）。
export function isSlotDue(slot, now = new Date()) {
  // 缺 enabled 也按关闭处理：存储层 normalizeProactiveSlot 会给默认 true，
  // 走到这里的对象若没有该字段，说明来源不可信（手改/旧数据），宁可不发也不乱发。
  if (!slot || slot.enabled !== true) return false;
  const hour = Number(slot.hour);
  const minute = Number(slot.minute);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return false;
  const target = new Date(now);
  target.setHours(hour, minute, 0, 0);
  const windowMinutes = Math.max(0, Number(slot.windowMinutes) || 0);
  const end = new Date(target.getTime() + (windowMinutes > 0 ? windowMinutes : 1) * 60 * 1000);
  return now >= target && now < end;
}
