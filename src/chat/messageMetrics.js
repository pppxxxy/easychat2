// 消息体积的统一计量器：一次扫描产出全部口径（2026-10-18）。
//
// 为什么需要它：仓库里此前有**三套**体积口径，各自实现、各自演进——
//   ① JSON.stringify(整数组).length        —— compaction.estimateMessagesBytes（全量）
//   ② Σ JSON.stringify(每条).length + (n-1) —— compaction.createMessageBytesEstimator（增量）
//   ③ Σ(4 + 内容 token)                     —— tokenEstimate.estimateMessagesTokens（token）
// ①②之间有一个**只在注释里约定**的差异：② 不数数组的 `[` `]` 两个字节。
// 2026-10-17 就因此踩过一次：`compactionStatusIncremental(messages)` 单参误用让体积恒为 0，
// 而「② 比 ① 少 2 字节」这件事只写在 compaction.js 的注释里，靠一条测试断言
// `full.bytes - incremental.bytes === 2` 钉着。这类「约定藏在注释里」的口径迟早再出事。
//
// 本模块把差异**显式化**：ARRAY_BRACKET_BYTES = 2，由调用方决定加不加（见 bytesJsonOf）。
// 三个数一次扫描产出，且按消息引用缓存（WeakMap），流式每 tick 只算尾部一条。
//
// 口径定义（与既有实现逐字节一致，不许漂移）：
//   bytesJson       = Σ JSON.stringify(每条).length            —— 不含数组括号与逗号
//   bytesArray      = bytesJson + (n>1 ? n-1 : 0) + 2           —— 等价于 JSON.stringify(数组).length
//   tokens          = Σ(4 + 内容 token)，CJK 约 1 token/字、其余 4 字符/token
// 注意 ② 的 `+2` 是**数组括号**，`+(n-1)` 是**逗号**；两者分开记，避免再次混为一谈。
import { estimateMessageTokens } from '../localModel/tokenEstimate.js';
import { messageTextOf } from './messageText.js';
// 统一派生引擎（结构 1）：按消息引用缓存，无键即纯按引用。
import { createMessageDerivation } from './messageDerivationStore.js';

// 数组序列化时的两个方括号。全量口径含它，逐条累加口径不含——显式常量，不再是注释里的约定。
export const ARRAY_BRACKET_BYTES = 2;

// 逐条计量缓存：由统一引擎承担（WeakMap<消息, 结果>，无失效键）。
// **token 也必须缓存**：它是逐字符扫描（CJK 判定走正则），2000 条 × 300 字实测约
// 12.9 ms/次，此前每次调用都全量重扫，是「取全部三个数」里最贵的一项。

function jsonLengthOf(message) {
  let size = 0;
  try {
    size = JSON.stringify(message).length;
  } catch (error) {
    size = 0;
  }
  return size;
}

// 单条消息的计量结果。
//
// token 的入参**必须适配**：estimateMessageTokens 读的是 `message.content`，而聊天消息的
// 正文在 `message.text`（工作区面板的才在 content）。contextUsage.estimateHistoryTokens
// 早就做了这个适配（`{ role, content: messageTextOf(item) }`），这里照抄同一口径——
// 直接把原始消息丢进去会得到「只有 overhead、正文 0 token」的错数（实测：
// {role:'user',text:'你好世界'} 直接传得 4，适配后得 8）。
// 唯一真源是 messageText.js 的 messageTextOf（它同时认 text 与 content）。
//
// 2026-10-18（结构 1 批次 1）：缓存改用统一引擎 createMessageDerivation（无键 ⇒ 纯按引用）。
// 这是**第一个迁移的消费点**，用来验证引擎在真实代码里可用；其余四处（displayTextCache /
// 搜索 matchCache / scrubber previewCache / messageDerivations 的三个容器）留到批次 2。
const deriveMetrics = createMessageDerivation({
  compute: message => ({
    jsonBytes: jsonLengthOf(message),
    tokens: estimateMessageTokens({
      role: message.role,
      content: messageTextOf(message),
    }),
  }),
});

export function messageMetrics(message) {
  if (message && typeof message === 'object') return deriveMetrics(message);
  // null / 非对象：JSON 序列化为 'null'（4 字节）；token 仍走估算器（它自己会加
  // 角色/分隔开销 4 —— 与旧实现 estimateHistoryTokens([null]) === 4 一致，不是新偏差）。
  return {
    jsonBytes: 4,
    tokens: estimateMessageTokens({ role: undefined, content: '' }),
  };
}

// 整个数组的计量：{ bytesJson, bytesArray, tokens, count }。
// bytesJson  = 逐条之和（不含括号/逗号）
// bytesArray = 等价于 JSON.stringify(数组).length（含括号与逗号）
export function messagesMetrics(messages) {
  const list = Array.isArray(messages) ? messages : [];
  let bytesJson = 0;
  let tokens = 0;
  for (const message of list) {
    const metrics = messageMetrics(message);
    bytesJson += metrics.jsonBytes;
    tokens += metrics.tokens;
  }
  const separators = list.length > 1 ? list.length - 1 : 0;
  return {
    count: list.length,
    bytesJson,
    bytesArray: bytesJson + separators + ARRAY_BRACKET_BYTES,
    tokens,
  };
}

// 便捷：只要全量口径的字节数（等价于 JSON.stringify(list).length）。
// 供 estimateMessagesBytes 这类「必须与真实序列化逐字节相等」的调用点使用。
export function bytesArrayOf(messages) {
  return messagesMetrics(messages).bytesArray;
}

// 便捷：只要逐条累加口径（**含** (n-1) 个逗号分隔符，不含数组括号）。
// 这是 compaction 增量估算器的历史口径——它此前是「Σ逐条 + (n-1) 逗号」，
// 与全量口径恰好差那 2 个括号字节。名字里的 Json 指「逐条 JSON 之和」，
// 分隔符是数组序列化的一部分，故一并算进来。
export function bytesJsonOf(messages) {
  const metrics = messagesMetrics(messages);
  const separators = metrics.count > 1 ? metrics.count - 1 : 0;
  return metrics.bytesJson + separators;
}
