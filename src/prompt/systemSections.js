// 系统提示的**分节**组装（Z 系采纳点 #1，对照 zai-org/ZCode 的 ContextBuilder）。
//
// 为什么分节：系统提示现在是一根不断 prepend/append 的字符串，既看不出「哪一段是什么」，
// 也无法判断「哪些内容跨轮稳定」——而供应商的 prompt 缓存（Anthropic 的
// `cache_control: {type:'ephemeral'}`、OpenAI 兼容端点的自动前缀缓存）**只认前缀**：
// 只有把跨轮不变的内容放在最前面并打上缓存断点，第二次请求起的这部分 token 才会命中缓存。
//
// 本模块做两件事，都是纯函数、Node 直测：
// 1. 把系统提示拆成有序的 section（每节带 id 与 cacheHint），组装文本与原实现**逐字节一致**；
// 2. 计算「最长稳定前缀」的缓存断点位置，交给协议层打 cache_control。
//
// 顺序照搬原实现（worldBefore 在最前、格式约束在最后）——不改行为，只做结构化 + 标注。

// 各 section 的稳定性：跨轮内容不变 = stable，随轮次/时间/历史变化 = dynamic。
// 只有 stable 段值得进缓存前缀（缓存按**块**打到断点处，见 planSystemCache）。
export const SECTION_CACHE = Object.freeze({
  worldBefore: 'dynamic',
  location: 'dynamic',
  schedule: 'dynamic',
  time: 'dynamic',
  base: 'stable',
  downloadImage: 'stable',
  sticker: 'stable',
  persona: 'stable',
  example: 'stable',
  worldAfter: 'dynamic',
  characterPresets: 'stable',
  globalPresets: 'stable',
  summary: 'dynamic',
  memory: 'dynamic',
  group: 'dynamic',
  extra: 'dynamic',
  format: 'stable',
});

// 组装顺序（与原实现一致）：worldBefore → location → schedule → time → base → persona →
// example → worldAfter → 角色预设 → 全局预设 → 记忆摘要 → 记忆召回 → 群聊 → 本轮任务 → 输出格式。
const SECTION_ORDER = [
  'worldBefore',
  'location',
  'schedule',
  'time',
  'base',
  'downloadImage',
  'sticker',
  'persona',
  'example',
  'worldAfter',
  'characterPresets',
  'globalPresets',
  'summary',
  'memory',
  'group',
  'extra',
  'format',
];

function makeSection(id, content) {
  const text = String(content == null ? '' : content);
  if (!text.trim()) return null;
  return {
    id,
    cacheHint: SECTION_CACHE[id] || 'dynamic',
    chars: text.length,
    content: text,
  };
}

// 入参是**已处理好的**各段文本（worldInfo 已过正则、占位符已替换），
// 本函数只负责排序、丢弃空段、标注稳定性。
export function buildSystemSections(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const byId = {
    worldBefore: source.worldBeforeText,
    location: source.locationText,
    schedule: source.scheduleText,
    time: source.timeText,
    base: source.baseText,
    downloadImage: source.downloadImageText,
    sticker: source.stickerText,
    persona: source.personaText ? `[用户设定]\n${source.personaText}` : '',
    example: source.exampleText ? `[对话示例]\n${source.exampleText}` : '',
    worldAfter: source.worldAfterText,
    characterPresets: source.characterPresetText ? `[角色预设]\n${source.characterPresetText}` : '',
    globalPresets: source.globalPresetText ? `[全局预设]\n${source.globalPresetText}` : '',
    summary: source.summaryText ? `[记忆摘要]\n${source.summaryText}` : '',
    memory: source.memoryText,
    group: source.groupText,
    extra: source.extraText ? `[本轮任务]\n${source.extraText}` : '',
    format: source.formatText ? `[输出格式]\n${source.formatText}` : '',
  };
  return SECTION_ORDER.map(id => makeSection(id, byId[id])).filter(Boolean);
}

// 组装成最终系统提示文本。分隔符与原实现一致（段间空一行）。
export function composeSystemText(sections) {
  return (Array.isArray(sections) ? sections : [])
    .map(section => (section && typeof section.content === 'string' ? section.content : ''))
    .filter(Boolean)
    .join('\n\n');
}

// 缓存断点：**最长 stable 连续段**的末尾（2026-10-11 P1）。
//
// 事故形态：此前只认「从第 0 段起连续 stable」，于是 worldBefore（世界书注入，dynamic）
// 排在系统提示最前时 breakIndex === 0 —— **一个断点都不打**，base / persona / 预设 /
// format 这些跨轮稳定的段永远进不了缓存前缀。而「有世界书」恰恰是长会话的常态，
// 等于 Anthropic 的提示缓存在最需要它的场景下完全失效。
//
// 为什么不重排 SECTION_ORDER：那会改变系统提示的**文本顺序**，破坏「逐字节一致」的
// 既有承诺（也影响模型行为）。改为把「稳定段连成的块」标上 cache_control：
// Anthropic 按**块**打标，断点落在稳定块末尾时，它之前的全部内容（含动态的
// worldBefore）都进缓存前缀——正是我们想要的（那段也逐轮不变，只是不该被当成
// 「稳定前缀的起点」而已）。
//
// 同长度取**最早**的那一段：缓存前缀越长收益越大，且与旧行为（取开头那段）在
// 「首段即 stable」时完全一致。
//
// 返回 { breakIndex, endIndex, stableChars, totalChars, cacheable }：
//  · breakIndex —— 与 endIndex 同值（旧名字，调用方按「下标」用：见 splitSystemForCache）；
//  · endIndex   —— 该段最后一段之后的**下标**（0 = 没有 stable 段）；
//  · cacheable  —— endIndex > 0。注意它不再等价于「从 0 起连续 stable」。
export function planSystemCache(sections) {
  const list = Array.isArray(sections) ? sections : [];
  let endIndex = 0;
  let stableChars = 0;
  let start = -1;
  for (let index = 0; index <= list.length; index += 1) {
    const stable = index < list.length && list[index] && list[index].cacheHint === 'stable';
    if (stable) {
      if (start < 0) start = index;
      continue;
    }
    if (start >= 0) {
      const chars = list.slice(start, index).reduce((sum, item) => sum + (Number(item && item.chars) || 0), 0);
      // 严格大于：同长度保留**先出现的**那段（更长的前缀 + 与旧行为一致）。
      if (chars > stableChars) {
        stableChars = chars;
        endIndex = index;
      }
      start = -1;
    }
  }
  return {
    breakIndex: endIndex,
    endIndex,
    stableChars,
    totalChars: list.reduce((sum, section) => sum + (Number(section && section.chars) || 0), 0),
    cacheable: endIndex > 0,
  };
}

// 把 section 切成「连续同稳定性的块」：stable 段并成一块、dynamic 段各自成块。
// 拼起来与原 composeSystemText 的文本**逐字节一致**（块间仍是空一行），
// 所以给 Anthropic 换成块数组不会改变发给模型的内容。
export function buildSystemChunks(sections) {
  const list = Array.isArray(sections) ? sections : [];
  const chunks = [];
  for (const section of list) {
    if (!section) continue;
    const stable = section.cacheHint === 'stable';
    const last = chunks[chunks.length - 1];
    if (last && last.stable === stable) {
      last.text = `${last.text}\n\n${section.content}`;
      last.chars += Number(section.chars) || 0;
    } else {
      chunks.push({ stable, text: String(section.content), chars: Number(section.chars) || 0 });
    }
  }
  return chunks;
}

// 按缓存断点把系统提示切成「可缓存前缀 + 其余」。断点为 0 时前缀为空串（调用方据此不打标记）。
export function splitSystemForCache(sections, breakIndex) {
  const list = Array.isArray(sections) ? sections : [];
  const index = Math.min(Math.max(0, Number(breakIndex) || 0), list.length);
  return {
    prefixText: composeSystemText(list.slice(0, index)),
    restText: composeSystemText(list.slice(index)),
  };
}
