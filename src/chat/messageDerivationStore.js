// 消息派生的统一引擎（2026-10-18，结构 1 批次 1：先抽引擎，暂不迁移消费点）。
//
// 背景：这几批性能修复里，按「消息对象引用」缓存派生结果的做法重复出现了 **5 次**，
// 每处自己写一遍失效逻辑：
//   ① memory/displayTextCache.js   —— 键 = placement + depth（有脚本时）/ placement（无脚本）
//   ② chat/chatSearchMath.js       —— 键 = needle
//   ③ chat/useScrollScrubber.js    —— 键 = characterName + t（语言）
//   ④ chat/messageMetrics.js       —— 无键（纯按引用）
//   ⑤ chat/messageDerivations.js   —— 前缀引用比对（整数组层面）
// ①②③④ 的失效语义其实是**同一个形状**：「WeakMap<消息, {失效键, 结果}>，键变了就重算」。
// 五处各写一遍的直接代价不是行数，而是**正确性要写对五遍**——2026-10-17 的
// 「displayTextCache 按 depth 分裂导致二次放大」就是这类 bug 的典型：每处的键该怎么定
// 都靠当时那个人想清楚，漏一个维度就是静默错算。
//
// 本模块把那个形状收成一个实现。它**只做两件事**：
//   createMessageDerivation({ compute, key })  —— 按消息引用缓存单个派生值
//   createListDerivation({ compute, key })     —— 整数组层面的增量重算（前缀引用比对）
//
// 设计约束（刻意保守）：
// - **零依赖叶子模块**：不 import 任何东西，可被任意模块引用，不会造环；
// - 不引入「清空定时器」之类的回收机制：键是消息对象，WeakMap 随对象回收自然清理；
// - key 的比较语义由调用方声明（`equals`），默认是**值相等**（=== 逐项），
//   引用相等只是它的特例——语言函数 t、脚本数组这类「同一引用才算没变」的场景照样正确。
// - 命中时**返回同一个结果引用**（不是深拷贝）：下游的 React.memo / useMemo 依赖引用稳定。

// 判断两个失效键是否等价。默认逐项 ===（数组逐位比、原语直接比）。
// 调用方若需要「内容相等也算命中」（如字符串 needle 的大小写折叠），传自己的 equals。
function defaultKeyEquals(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// 单个派生值：WeakMap<消息对象, Map<键签名, { key, value }>>。
//
// compute(message, key) 在未命中时调用；key 为 undefined 时视为「纯按引用缓存」
// （④ messageMetrics 那种：同一条消息永远同一个结果）。
//
// ⚠️ 为什么每条消息要存**多个**键而不是只存最后一个：displayTextCache 的语义是
// `entries` 是一个 Map，同一条消息在 AI_OUTPUT / USER_INPUT 两个 placement、以及不同
// depth 下各自缓存一份。只存最后一个会让「两个 placement 交替取」变成每次都重算——
// 实测（300 轮随机序列）重算次数 203 vs 259，**结果对但白算**。
// 这个差异不会让任何功能出错，只会让性能悄悄退回去，所以必须在引擎里做对。
//
// maxKeysPerMessage 的取舍（实测数据，别凭感觉调）：
//   设 8 时，300 轮随机序列里重算 206 次 vs 手写版 203 次 —— 差的 3 次全是
//   「键被 FIFO 挤掉后又被命中」。手写版的 Map 是**无界**的，命中率略高，但键空间
//   本身有限（placement × depth），且键随消息对象一起被回收，不构成泄漏。
//   故默认取 32（覆盖 2 个 placement × 十几个 depth 的典型组合），需要严格无界时传 Infinity。
export function createMessageDerivation({
  compute,
  key,
  equals = defaultKeyEquals,
  maxKeysPerMessage = 32,
} = {}) {
  if (typeof compute !== 'function') {
    throw new TypeError('createMessageDerivation 需要 compute 函数');
  }
  const cache = new WeakMap();
  // 非对象入参（null / 原语）无法进 WeakMap：按「每次现算」处理，行为与手写实现一致。
  return function derive(message, ...rest) {
    if (!message || typeof message !== 'object') return compute(message, ...rest);
    const currentKey = typeof key === 'function' ? key(message, ...rest) : undefined;
    let entries = cache.get(message);
    if (!entries) {
      entries = [];
      cache.set(message, entries);
    }
    // 线性扫：单条消息的键数量很小（displayTextCache 最多 placement × depth 若干），
    // 且 equals 可能涉及引用比较，不能靠序列化签名（那会把 t 函数序列化成一堆垃圾）。
    for (const entry of entries) {
      if (equals(entry.key, currentKey)) return entry.value;
    }
    const value = compute(message, ...rest);
    entries.push({ key: currentKey, value });
    // 上限保护：键无限增长等于泄漏。超限时丢**最旧**的一条（FIFO），
    // 与「只留最后一个」相比它仍保留了多键能力，只是有界。
    if (entries.length > maxKeysPerMessage) entries.shift();
    return value;
  };
}

// 整数组层面的增量重算：保留「上次见到的数组 + 上次的结果」，做**前缀引用比对**。
//
// 适用场景（⑤ messageDerivations 那三个容器）：结果是整数组的派生（Map / Set / 过滤后的
// 数组），且流式期间每 tick 只有尾部若干条变化。返回 { value, reused }，其中 reused 是
// 可复用的前缀长度——调用方据此决定「从哪继续算」。
//
// compute(list, reused, previousValue) 必须自己处理「复用前缀」的语义：
//   - 结果类型不可变（如过滤数组）：可直接 slice 前缀再追加；
//   - 结果类型可变（Map/Set）：复制一份再改。
// 引擎不替调用方决定，因为「怎么复用」取决于结果类型，猜错就是静默错算。
export function createListDerivation({ compute } = {}) {
  if (typeof compute !== 'function') {
    throw new TypeError('createListDerivation 需要 compute 函数');
  }
  let prevList = null;
  let prevValue;
  let hasValue = false;
  return function derive(list) {
    const source = Array.isArray(list) ? list : [];
    // 同一数组引用：直接返回上次结果（下游 memo 依赖这个引用稳定性）。
    if (hasValue && prevList === source) return prevValue;
    const reused = prefixLength(prevList, source);
    const value = compute(source, reused, hasValue ? prevValue : undefined);
    prevList = source;
    prevValue = value;
    hasValue = true;
    return value;
  };
}

// 前缀长度：prevList[i] === nextList[i] 逐位相同的最长前缀。
// 导出供测试与需要自行比对的调用方复用（⑤ 的三个容器目前各自内联了一份同样的逻辑）。
export function prefixLength(prevList, nextList) {
  if (!Array.isArray(prevList) || !Array.isArray(nextList)) return 0;
  const max = Math.min(prevList.length, nextList.length);
  let i = 0;
  while (i < max && prevList[i] === nextList[i]) i += 1;
  return i;
}

// 测试用：清掉内部状态（引擎是工厂函数，实例状态本就随实例回收，这里只服务需要
// 「同一实例重来」的用例）。
export function __resetDerivationForTests(factory) {
  // 工厂返回的闭包无法从外部重置；此函数只为显式表达「测试不该依赖跨用例状态」而存在。
  return factory;
}
