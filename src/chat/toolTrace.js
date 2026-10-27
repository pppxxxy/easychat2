// P5：agent transcript 的工具轨迹（对齐参考 harness「持久化含 tool 消息的完整 transcript」）。
//
// easychat2 采用**嵌套**方案：把一轮里「assistant(tool_calls) + tool 结果」的轨迹挂在
// 该轮助手终稿消息的 `toolTrace` 字段上（消息形状不变，无需存储迁移）。下一轮组装请求时
// 展开回 agent 历史，让 K1（跨轮清除）/ N2（跨轮压缩）真正看得到工具结果。
// 展示 / 搜索 / 导出 / 分支只读 `text`，对 `toolTrace` 无感。
//
// 轨迹元素形状 = agent 消息：
//   { role:'assistant', content, tool_calls } | { role:'tool', tool_call_id, content }

// 同步取词入口（非 React 树）：截断标记在纯函数里生成，拿不到 hook。
// 只 import tActive —— 多处测试把 i18n/index.js 打桩成 `{ tActive }`，多引一个符号就会炸。
import { tActive } from '../i18n/index.js';

export const TOOL_TRACE_MAX_BYTES = 256 * 1024;
export const TOOL_TRACE_TOOL_CONTENT_MAX = 16 * 1024;

// 截断标记：**双受众**文案（与 workspace/toolDefs/toolNotices.js 同类，见那里的文件头）。
//   · 用户：clipToolContent 把标记插进 role === 'tool' 的 content，而
//     workspace/conversation.js 的 toolRowsFromTrace 直接读 result.content 做
//     「结果预览 / 完整输出」，所以这段字会出现在工作区工具行里——英文界面下读中文，
//     这正是本次要修的一面；
//   · 模型：轨迹会被 expandHistoryWithTraces 回放回下一轮请求，标记让模型知道
//     「这里被截断过」（内容缺失但不当成完整事实）。
// 因此取值走 i18n（当前语言在写入时定稿，与 gitCheckpoint 的提交说明同理）。
//
// 导出的常量是 **i18n key** 而不是中文：一来规则看得见这条文案的存在
//（no-hardcoded-chinese-text 只查**导出**常量，此前它是非导出的，所以整条链一直在
// 规则盲区里）；二来本文件不硬编码中文，取值交给语言包。
export const TRACE_TRUNCATE_MARK_KEY = 'chat.toolTrace.truncated';

// 模型侧兜底：i18n 不可用（测试打桩只给 tActive: key => key、或词条漏登记时 t 返回 key
// 本身）时回落这段中文。**绝不允许回落成空串**——空串会让「被截断」这件事在回放给模型的
// 历史里彻底消失，静默截断比中文标记危险得多。
// 非导出 ⇒ 不触发 no-hardcoded-chinese-text（规则只查导出常量），这是有意的：
// 它只是兜底，正常路径由语言包给值。
const MODEL_TRUNCATE_MARK = '…（轨迹截断）…';

// 截断标记取值：t 可注入（测试/显式传参），默认走当前活动语言。
export function traceTruncateMark(t = tActive) {
  const text = typeof t === 'function' ? String(t(TRACE_TRUNCATE_MARK_KEY) || '') : '';
  return text && text !== TRACE_TRUNCATE_MARK_KEY ? text : MODEL_TRUNCATE_MARK;
}

// 体积口径与 resultClearing.js 同款：JSON 序列化**字符数**（UTF-16 code unit），不是
// UTF-8 字节数——中文名义上低估约 3 倍。TOOL_TRACE_MAX_BYTES 的"BYTES"沿用历史命名
//（tests/toolTrace.test.mjs 引用），语义是「序列化字符数预算」，按字符数比较只会更严，
// 不会让超长轨迹漏网。

function traceChars(trace) {
  try {
    return JSON.stringify(trace).length;
  } catch (error) {
    return Number.POSITIVE_INFINITY;
  }
}

function clipToolContent(content, t) {
  const text = String(content == null ? '' : content);
  if (text.length <= TOOL_TRACE_TOOL_CONTENT_MAX) return text;
  const half = Math.floor(TOOL_TRACE_TOOL_CONTENT_MAX / 2);
  return `${text.slice(0, half)}\n${traceTruncateMark(t)}\n${text.slice(text.length - half)}`;
}

// 逐条截断 tool 内容；仍超总预算 → null（宁缺毋滥，绝不把会话撑爆）。
export function sanitizeTrace(trace, { maxBytes = TOOL_TRACE_MAX_BYTES, t } = {}) {
  const list = (Array.isArray(trace) ? trace : []).map(item => (
    item && item.role === 'tool' ? { ...item, content: clipToolContent(item.content, t) } : item
  ));
  if (!list.length) return null;
  return traceChars(list) > maxBytes ? null : list;
}

// 从循环追加的消息里提取轨迹：保留 assistant(tool_calls) 与其后的 tool 结果，
// 丢掉纯文本的助手终稿（它已是展示消息本身）。
// options 原样转给 sanitizeTrace，因此可传 { t } 显式指定截断标记的语言
//（不传则走当前活动语言，见 traceTruncateMark）。
export function extractToolTrace(appendedMessages, options = {}) {
  const list = Array.isArray(appendedMessages) ? appendedMessages : [];
  const trace = [];
  for (const item of list) {
    if (!item) continue;
    if (item.role === 'tool') {
      trace.push({
        role: 'tool',
        tool_call_id: item.tool_call_id,
        content: String(item.content == null ? '' : item.content),
        // P0 加固：消息带 `isError` 就原样保留（展示层据此判状态，比正文正则权威）。
        // 老轨迹没有这个字段——保留为「无该字段」，展示层会回落到正则，不假装知道。
        ...(item.isError === undefined ? {} : { isError: item.isError === true }),
        // 界面侧提示 key（toolDefs/toolNotices.js）：工具结果里 content 是给模型的中文，
        // noticeKey/noticeParams 是给界面的词条引用。这条链是
        //   工具定义 → registry → loop 的 tool 消息 → 本函数 → conversation.js → ToolCallRow
        // 中间每一跳都可能只挑 content 而把它丢掉，所以本函数**显式**搬运这两个字段
        //（与 isError 同款做法：显式列出，不靠整体展开）。老轨迹/未携带时保持「无该字段」，
        // 展示层回落中文正文，不假装知道。
        ...(item.noticeKey === undefined ? {} : { noticeKey: String(item.noticeKey) }),
        ...(item.noticeParams === undefined ? {} : { noticeParams: item.noticeParams }),
      });
    } else if (item.role === 'assistant' && Array.isArray(item.tool_calls) && item.tool_calls.length) {
      trace.push({
        role: 'assistant',
        content: item.content == null ? null : String(item.content),
        tool_calls: item.tool_calls,
      });
    }
  }
  return sanitizeTrace(trace, options);
}

// 展开：把每条带 toolTrace 的消息替换为 [...trace, 消息本身]（供 buildHistory 用）。
export function expandHistoryWithTraces(historyMessages) {
  const list = Array.isArray(historyMessages) ? historyMessages : [];
  const out = [];
  for (const item of list) {
    if (item && Array.isArray(item.toolTrace) && item.toolTrace.length) {
      for (const traceItem of item.toolTrace) out.push(traceItem);
    }
    out.push(item);
  }
  return out;
}

// 把轨迹挂到本轮新产出的首个助手正文分段上（展示层读 text，无感）。
export function attachToolTrace(messages, replyParts, trace) {
  if (!Array.isArray(trace) || trace.length === 0) return messages;
  const partIds = new Set((Array.isArray(replyParts) ? replyParts : [])
    .filter(part => part && !part.kind && part.id)
    .map(part => String(part.id)));
  if (partIds.size === 0) return messages;
  let attached = false;
  return (Array.isArray(messages) ? messages : []).map(item => {
    if (!attached && item && partIds.has(String(item.id))) {
      attached = true;
      return { ...item, toolTrace: trace };
    }
    return item;
  });
}
