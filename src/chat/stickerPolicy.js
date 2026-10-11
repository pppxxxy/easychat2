// 表情包策略：概率与位置的纯逻辑（零 RN 依赖，Node 直测）。
//
// 背景：表情包「教学」原先挂在一条全局预设上（src/settings/presets.js 的「表情包使用」），
// 需手动开启、且老用户持久化的预设列表里根本没有它，实际从未触发。改为「聊天开关 + 概率」
// 之后，概率判定与位置归一化需要可测的纯逻辑，集中在这里。

export const DEFAULT_STICKER_CHANCE = 0.5;

// 位置：文字下方（默认，与旧行为一致）/ 文字上方。
export const STICKER_POSITIONS = Object.freeze(['below', 'above']);

// 归一化概率：非法/缺失回落默认；夹取到 [0, 1]。
export function normalizeStickerChance(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return DEFAULT_STICKER_CHANCE;
  if (num <= 0) return 0;
  if (num >= 1) return 1;
  return num;
}

// 位置归一化：只认 below/above，其余回落 below。
export function normalizeStickerPosition(value) {
  return value === 'above' ? 'above' : 'below';
}

// 本轮是否允许发表情包：开关关闭 / 无表情包 / 概率未命中 → 不允许。
// random 可注入（默认 Math.random）以便测试；chance=1 恒真、chance=0 恒假。
export function shouldSendStickers({ enabled, hasStickers, chance, random } = {}) {
  if (!enabled || !hasStickers) return false;
  const roll = typeof random === 'number' ? random : Math.random();
  return roll < normalizeStickerChance(chance);
}
