// 采样参数的可视化：8 个候选词的概率分布（纯函数，零 RN 依赖，Node 直测）。
//
// 命名注意：本模块叫 samplingDistribution.js（**不能**叫 samplingChart.js）——
// Windows 文件系统大小写不敏感，samplingChart.js 与组件 SamplingChart.js 会是
// 同一个文件，两者互相覆盖（真踩过）。
//
// 为什么单独一个模块：这张图的价值全在**数学口径正确**——它必须画出「真实采样管线
// 会发生什么」，而不是「看起来差不多的一条曲线」。而真实管线是**有序**的：
//
//   ① 温度（Temperature）：p_i' ∝ p_i^(1/T)
//      这不是凑出来的近似——它是 softmax(logits/T) 的等价形式：
//      设 p = softmax(logits)，则 softmax(logits/T)_i = p_i^(1/T) / Σ_j p_j^(1/T)。
//      · T < 1 → 指数 1/T > 1 → 差异被放大（分布尖锐）
//      · T > 1 → 指数 1/T < 1 → 差异被压缩（分布平缓）
//      · T = 1 → 原样
//      实现上按真实 softmax 做（log(p)/T 再过 softmax），而不是手写幂次归一——
//      两者数学等价，但走 log/exp 能顺带把 T→0 的除零问题变成可夹取的数值问题。
//   ② top-k：按 p' 取前 k 根，其余标记为「被裁掉」（图上隐藏/变暗）。
//   ③ top-p：在**存活集**上重新归一后，从高到低累加，达到阈值即截断。
//      真实管线正是 temperature → top-k → top-p，所以 top-p 必须在存活集上算，
//      在全集上算会得出「选中的根数偏少」的错误结论。
//
// 输出同时给「概率」与「显示高度比例」：前者是事实（可读作 40%），后者是画图用的
// （最高的柱子占满高度，形状差异才看得清）。两个都返回，调用方各取所需。

// 8 个候选词的初始概率（用户指定）：40% / 35% / 10% / 5% / 4% / 3% / 2% / 1%。
export const CANDIDATE_BASE_PROBABILITIES = Object.freeze([
  0.40, 0.35, 0.10, 0.05, 0.04, 0.03, 0.02, 0.01,
]);

// 温度的可视化下限：真实采样的温度不该是 0（等价于 argmax），但用户可能填 0。
// 夹到这个下限让图仍可绘制（极端尖锐），且避免 log/exp 溢出。
export const MIN_VISUAL_TEMPERATURE = 0.05;
// 低于该值的概率视为「长尾已截断」，图上按 0 高度处理（避免 1e-30 这种画不出的柱子）。
const NEGLIGIBLE_PROBABILITY = 1e-6;

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// 纯函数：按温度重算分布（softmax(log(p)/T)）。返回与输入等长的概率数组。
// T<=0 夹到 MIN_VISUAL_TEMPERATURE（等价 argmax 的极端形态，图仍可画）。
export function applyTemperature(baseProbabilities, temperature) {
  const base = (Array.isArray(baseProbabilities) ? baseProbabilities : [])
    .map(item => Number(item))
    .filter(item => Number.isFinite(item) && item > 0);
  if (base.length === 0) return [];
  const t = clampNumber(temperature, MIN_VISUAL_TEMPERATURE, 1000, 1);
  // log 域：logit_i = log(p_i)；温度缩放后过 softmax。数值稳定（减去最大值）。
  const logits = base.map(p => Math.log(p) / t);
  const maxLogit = Math.max(...logits);
  const exps = logits.map(item => Math.exp(item - maxLogit));
  const total = exps.reduce((acc, item) => acc + item, 0);
  if (!(total > 0)) return base.map(() => 1 / base.length);
  return exps.map(item => item / total);
}

// 纯函数：按 top-k 标记存活（k<=0 或 k>=总数 = 全存活）。
export function applyTopK(probabilities, topK) {
  const list = (Array.isArray(probabilities) ? probabilities : []).map(item => Number(item) || 0);
  const k = Math.floor(clampNumber(topK, 0, list.length, 0));
  if (k <= 0 || k >= list.length) return list.map(() => true);
  // 按概率降序取前 k 个（同值按原序稳定）——返回的是「原下标是否存活」。
  const order = list
    .map((probability, index) => ({ probability, index }))
    .sort((a, b) => (b.probability - a.probability) || (a.index - b.index));
  const kept = new Set(order.slice(0, k).map(item => item.index));
  return list.map((_, index) => kept.has(index));
}

// 纯函数：按 top-p 标记选中。在**存活集**上重新归一后从高到低累加，达到阈值即截断。
// 返回「原下标是否被选中」。
// · p >= 1 → 全选中（与用户要求「Top-p=1 时全高亮」一致）
// · p <= 0 → 只选最高的那一个（退化态；真实采样不会配 0，但不能画出空图）
export function applyTopP(probabilities, keptFlags, topP) {
  const list = (Array.isArray(probabilities) ? probabilities : []).map(item => Number(item) || 0);
  const kept = (Array.isArray(keptFlags) ? keptFlags : []).map(item => item === true);
  const selected = list.map(() => false);
  const survivors = list
    .map((probability, index) => ({ probability, index }))
    .filter(item => kept[item.index]);
  if (survivors.length === 0) return selected;
  const p = clampNumber(topP, 0, 1, 1);
  if (p >= 1) {
    survivors.forEach(item => { selected[item.index] = true; });
    return selected;
  }
  const total = survivors.reduce((acc, item) => acc + item.probability, 0);
  const order = survivors.slice().sort((a, b) => (b.probability - a.probability) || (a.index - b.index));
  if (!(total > 0)) {
    selected[order[0].index] = true;
    return selected;
  }
  let cumulative = 0;
  for (const item of order) {
    selected[item.index] = true;
    cumulative += item.probability / total;
    // 达到阈值即停：这一根是「让累计刚好达标」的那根，必须包含。
    if (cumulative >= p - 1e-9) break;
  }
  return selected;
}

// 纯函数：一次算出整张图要的数据。
// 返回 { bars, effectiveCount, keptCount, selectedCount, maxProbability }：
//   bars[i] = { index, probability, ratio, kept, selected }
//     · probability：温度调整后的真实概率（可读作百分比）
//     · ratio：显示高度比例（probability / maxProbability，最高柱 = 1）
//     · kept：是否通过 top-k（false = 被裁掉，图上隐藏/变暗）
//     · selected：是否落在 top-p 内（false = 长尾，图上变暗）
export function buildCandidateBars({
  base = CANDIDATE_BASE_PROBABILITIES,
  temperature = 1,
  topK = 0,
  topP = 1,
} = {}) {
  const probabilities = applyTemperature(base, temperature);
  const kept = applyTopK(probabilities, topK);
  const selected = applyTopP(probabilities, kept, topP);
  const visible = probabilities.map((probability, index) => (kept[index] ? probability : 0));
  const maxProbability = Math.max(...visible, 0);
  const bars = probabilities.map((probability, index) => ({
    index,
    probability: kept[index] ? probability : 0,
    ratio: maxProbability > 0 && kept[index]
      ? (probability > NEGLIGIBLE_PROBABILITY ? probability / maxProbability : 0)
      : 0,
    kept: kept[index],
    selected: kept[index] && selected[index],
  }));
  return {
    bars,
    effectiveCount: bars.length,
    keptCount: kept.filter(Boolean).length,
    selectedCount: selected.filter((item, index) => item && kept[index]).length,
    maxProbability,
  };
}
