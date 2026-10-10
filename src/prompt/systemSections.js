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
// 只有**从第一段起连续 stable** 的那一段才是可缓存前缀（缓存只认前缀）。
export const SECTION_CACHE = Object.freeze({
  worldBefore: 'dynamic',
  location: 'dynamic',
  schedule: 'dynamic',
  time: 'dynamic',
  base: 'stable',
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

// 最长稳定前缀的缓存断点：从第 0 段起连续 stable 的段数。
// breakIndex = 0 表示首段就是动态内容 → 没有可缓存前缀（不打缓存标记，零副作用）。
export function planSystemCache(sections) {
  const list = Array.isArray(sections) ? sections : [];
  let breakIndex = 0;
  let stableChars = 0;
  for (const section of list) {
    if (!section || section.cacheHint !== 'stable') break;
    breakIndex += 1;
    stableChars += Number(section.chars) || 0;
  }
  return {
    breakIndex,
    stableChars,
    totalChars: list.reduce((sum, section) => sum + (Number(section && section.chars) || 0), 0),
    cacheable: breakIndex > 0,
  };
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
