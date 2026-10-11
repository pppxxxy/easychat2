// E1 二期 / P1-1：Anthropic 显式缓存断点（cache_control）。
//
// 背景：OpenAI 系与 DeepSeek 是**自动**前缀缓存（什么都不用做，命中情况已由 E1 的
// usage 观测覆盖）；Anthropic 必须显式打 `cache_control: { type: 'ephemeral' }` 才会
// 缓存——这是「路已铺好、只差一步」的成本/延迟收益。
//
// 本模块只管三件事：**断点放哪、放几个、TTL 多长**。纯函数、可 Node 直测。
//
// 断点策略（最多 3 个，Anthropic 上限 4，留一个余量）：
// ① system 尾——角色设定 / 全局预设 / 世界书 / 工作区提示，最静态、收益最大；
// ② tools 尾——工具定义序列（agent 模式体积可观，且同一 mode 下逐字稳定）；
// ③ 历史稳定前缀——**倒数第二条**消息的最后一个块。最新一条（本轮用户输入或工具结果）
//    每轮都变，把它排除在断点之外；下一轮它变成历史时，前缀已经缓存好了。
//
// 关掉：`promptCacheTtl: 'off'`——有些 Anthropic 兼容网关不认这个字段，给一条退路
//（宁可少省点钱，也不能让请求被网关拒掉）。

export const PROMPT_CACHE_TTLS = Object.freeze(['off', '5m', '1h']);
export const DEFAULT_PROMPT_CACHE_TTL = '5m';
export const CACHE_BREAKPOINT_MAX = 4;

// 归一化：非法/缺失一律回落默认（'5m'）；认几种常见写法，其余当默认。
export function normalizePromptCacheTtl(value) {
  const text = String(value === undefined || value === null ? '' : value).trim().toLowerCase();
  if (text === 'off' || text === 'none' || text === 'false' || text === '0') return 'off';
  if (text === '1h' || text === 'hour' || text === '60m') return '1h';
  return DEFAULT_PROMPT_CACHE_TTL;
}

export function isPromptCacheEnabled(ttl) {
  return normalizePromptCacheTtl(ttl) !== 'off';
}

// Anthropic 的 cache_control：5m 是服务端默认，只在 1h 时才需要显式 ttl
//（少一个字段就少一次网关兼容风险）。
export function cacheControlFor(ttl) {
  const value = normalizePromptCacheTtl(ttl);
  if (value === 'off') return null;
  return value === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
}

// 给「最后一个块」打标（返回新数组，不改入参——纯函数纪律）。
function markLastBlock(blocks, control) {
  return blocks.map((block, index) => (
    index === blocks.length - 1 ? { ...block, cache_control: control } : block
  ));
}

// 返回新的 { system, messages, tools, breakpoints }。关闭时逐字原样返回入参。
export function applyAnthropicCacheControl({ system, messages, tools, ttl } = {}) {
  const control = cacheControlFor(ttl);
  if (!control) return { system, messages, tools, breakpoints: 0 };
  let breakpoints = 0;

  // ① system：字符串形态转成单块数组才能挂 cache_control（Anthropic 两种都收）。
  let nextSystem = system;
  if (typeof system === 'string' && system.trim()) {
    nextSystem = [{ type: 'text', text: system, cache_control: control }];
    breakpoints += 1;
  }

  // ② tools：只标最后一个（断点覆盖它之前的全部定义）。
  let nextTools = tools;
  if (Array.isArray(tools) && tools.length > 0) {
    nextTools = markLastBlock(tools, control);
    breakpoints += 1;
  }

  // ③ 历史稳定前缀：倒数第二条消息的最后一个块。
  let nextMessages = messages;
  if (Array.isArray(messages) && messages.length >= 2) {
    const index = messages.length - 2;
    const target = messages[index];
    if (target && Array.isArray(target.content) && target.content.length > 0) {
      nextMessages = messages.map((item, itemIndex) => (
        itemIndex === index ? { ...item, content: markLastBlock(item.content, control) } : item
      ));
      breakpoints += 1;
    }
  }

  return {
    system: nextSystem,
    messages: nextMessages,
    tools: nextTools,
    breakpoints: Math.min(breakpoints, CACHE_BREAKPOINT_MAX),
  };
}
