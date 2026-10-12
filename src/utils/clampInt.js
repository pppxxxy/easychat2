// 整数夹取（纯函数，零依赖）：非有限值 → fallback；否则取整并夹进 [min, max]。
//
// 为什么单独成文件：这段逻辑曾在四处各写一份，而且**参数顺序各不相同**——
//   storage/settings/imageRecognition.js  (value, min, max, fallback)
//   workspace/references.js               (value, fallback, min, max)
//   workspace/retention.js                (value, bounds, fallback)
//   workspace/toolDefs/searchTool.js      (value, fallback, min, max)
// 四处语义一致（min 均 >= 0，故 Math.floor 与 Math.trunc 在夹取后等价），但顺序不同正是
// 「照抄一份、改的时候传错位」的温床。所以这里**只留一种形状**，且用对象传边界，
// 让调用点不可能再把 min/max/fallback 传反。
//
// 消费方清单与「再长一份就红」的检查在 tests/clampIntSingleSource.test.mjs。

export function clampInt(value, { min, max, fallback }) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}
