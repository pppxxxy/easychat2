// ChatScreen 的纯辅助函数。从 src/ChatScreen.js 原样外提（无行为变化）。

import {
  ASSISTANT_ID,
  INLINE_IMAGE_PROMPT_MAX,
  NO_BODY_TEXT_KEY,
  QUOTE_TEXT_MAX,
  isThinkingPlaceholder,
} from './chatConstants.js';
import { STICKER_MESSAGE_KIND } from './chatMedia.js';
// 同步取词入口（非 React 树）：formatScrubberTime 在 hook 的 memo 里被调用、
// 也允许被纯函数式地直接调用，取词不能依赖 React 上下文。
// 只 import tActive —— 多处测试把 i18n/index.js 打桩成 `{ tActive }`，多引一个符号就会炸。
import { tActive } from '../i18n/index.js';

// 拼生图提示词：风格前缀 + 场景描述（场景描述由模型转写或本地兜底得到）。
export function buildInlineImagePrompt(sceneText, stylePrefix, maxChars) {
  const source = String(sceneText || '').replace(/\s+/g, ' ').trim();
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : INLINE_IMAGE_PROMPT_MAX;
  const clipped = source.length > limit ? source.slice(0, limit) : source;
  const prefix = String(stylePrefix || '').trim();
  if (!clipped) return prefix;
  return prefix ? `${prefix}, ${clipped}` : clipped;
}

// 图片/表情包消息的文字占位：这类消息 text 为空，但引用与回填都需要一段可读文本。
export function mediaQuoteText(message) {
  const stickerName = String(message?.image?.stickerName || '').trim();
  if (stickerName) return `【表情包：${stickerName}】`;
  if (message?.kind === STICKER_MESSAGE_KIND) return '【表情包】';
  return '【图片】';
}

export function buildQuotePayload(message, name) {
  if (!message || !message.id) return null;
  const raw = String(message.text || '').trim();
  // 图片/表情包消息没有正文：用占位文本参与引用，否则引用入口对这类消息永远返回 null。
  const body = raw || (message.image ? mediaQuoteText(message) : '');
  const text = body.length > QUOTE_TEXT_MAX ? `${body.slice(0, QUOTE_TEXT_MAX)}…` : body;
  if (!text) return null;
  return {
    id: message.id,
    name: String(name || '').trim(),
    role: message.role,
    text,
  };
}

export function getHttpStatus(error) {
  return error?.status || error?.statusCode || error?.response?.status || null;
}

// 兜底文案最终经 replyFlow → ErrorBubble 渲染给用户，走 i18n；常量是 key，取值经
// 语言包，i18n 打桩（tActive 恒等返回 key）或词条缺失时回落基准中文——绝不空串
//（同 toolTrace.traceTruncateMark 的「key + 基准回落」做法；回落串放函数体内，
// 本文件不在 no-hardcoded-chinese-text 的冻结清单里，模块级常量会被规则拦）。
export const CHAT_ERROR_FALLBACK_KEY = 'chat.error.fallbackText';

export function buildErrorRawText(error) {
  const localized = tActive(CHAT_ERROR_FALLBACK_KEY);
  const fallback = localized && localized !== CHAT_ERROR_FALLBACK_KEY
    ? localized
    : '请检查 API 配置或网络连接。';
  const message = error?.message || fallback;
  const status = getHttpStatus(error);
  const stack = error?.stack || '';
  const lines = [message];
  if (status) {
    lines.push(`HTTP 状态码: ${status}`);
  }
  if (stack) {
    lines.push(stack);
  }
  return lines.join('\n');
}

export function buildGreetingMessage(sessionId, firstMes, userName) {
  const text = String(firstMes || '').trim();
  if (!text) return null;
  const replaced = userName ? text.replace(/\{\{user\}\}/g, () => userName) : text;
  return {
    id: `greeting-${sessionId}`,
    role: ASSISTANT_ID,
    text: replaced,
    timestamp: Date.now(),
    kind: 'greeting',
    greetingTemplate: text,
  };
}

// 定位条时间标签的格式：**整句**走词条，而不是只把「月/日」两个字翻掉——
// 日期语序是语言的一部分（`1月2日 09:05` vs `1/2 09:05`），拼字符串必然在某个语言里别扭。
export const SCRUBBER_TIME_KEY = 'chat.scrubber.time';

export function formatScrubberTime(timestamp, t = tActive) {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) return '';
  const date = new Date(value);
  const pad = number => String(number).padStart(2, '0');
  const params = {
    month: date.getMonth() + 1,
    day: date.getDate(),
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  };
  // t 可注入（useScrollScrubber 手里就有 t，见那里的注释）；默认 tActive 是为了让
  // 尚未显式传 t 的调用点也跟随语言，而不是退回硬编码中文（本函数的旧行为）。
  const text = typeof t === 'function' ? String(t(SCRUBBER_TIME_KEY, params) || '') : '';
  // 词条漏登记时 t 返回 key 本身——不能把 `chat.scrubber.time` 显示给用户，
  // 故回落基准语言格式（与语言包 zh-CN 的值一致）。
  return text && text !== SCRUBBER_TIME_KEY ? text : `${params.month}月${params.day}日 ${params.time}`;
}

// 把一条 pending 占位消息“结算”：有内容（正文或思考）就保留并落盘，
// 只有占位符则整条移除。单聊、群聊-逐角色、群聊-合议三条路径的停止/失败
// 处理统一走这里，避免出现“生成的部分整条消失”或“永远停在正在思考”的僵尸气泡。
// t：占位符与「未生成正文」都是用户可见文案，随语言变——比较与取值都必须用同一个 t
// （拿写死的中文去比，英文界面下永远不相等，会把「Thinking...」当正文落盘）。
//
// P2 调研结论（2026-10-17，竞品警示 #7「只思考不说话」的呈现区分）——**现状已可，不改**：
// 本函数只服务**用户主动中止**那几条路径（useChatSend 的 379/822/903/1165/1250）。
// 中止且无正文时落 NO_BODY_TEXT_KEY「（未生成正文）」，而**非中止**的「只有思考、
// 没有正文」走另一条路（replyFlow.replacePendingWithReply → chat.send.noReply）。
// 两条路本就结构可分（signal.aborted / isCanceledError），且推理内容本身由
// MessageBubble.js:362 的 reasoning 块渲染出来（用户折叠可见、可展开）——即用户看到的是
// 「思考内容 + 一句无正文说明」，不是空白气泡，也不是笼统报错。因此不必新增
// 「思考终止/思考中断」两套文案；真要区分措辞，属于「聊天后台运行」立项时的消息状态设计。
export function settlePendingMessage(list, id, t) {
  const source = Array.isArray(list) ? list : [];
  return source.reduce((acc, item) => {
    if (!item || item.id !== id) {
      acc.push(item);
      return acc;
    }
    const text = typeof item.text === 'string' ? item.text : '';
    const reasoning = typeof item.reasoning === 'string' ? item.reasoning : '';
    const hasBody = text.trim().length > 0 && !isThinkingPlaceholder(text, t);
    if (!hasBody && reasoning.trim().length === 0) return acc;
    acc.push({
      ...item,
      pending: false,
      waitingForResponse: false,
      text: hasBody ? text : t(NO_BODY_TEXT_KEY),
    });
    return acc;
  }, []);
}

// 消息时间：优先用显式 timestamp 字段；旧消息没有该字段，
// 退化为从 id 前缀解析（历史行为），都对不上则返回 0。
export function messageTimestamp(message) {
  const explicit = Number(message && message.timestamp);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const fromId = Number(String((message && message.id) || '').split('-')[0]);
  return Number.isFinite(fromId) && fromId > 0 ? fromId : 0;
}

// 可落盘消息列表：剔除 pending 消息，剥掉瞬态字段（waitingForResponse /
// 未完成的配图 inlineImage）。settled 的配图保留原样（含 base64，历史行为）。
// 无瞬态字段的元素原引用返回，避免上层 memo 因新对象而失效。
export function buildPersistableMessages(messages) {
  return (messages || [])
    .filter(item => item && !item.pending)
    .map(item => {
      const hasWaiting = Object.prototype.hasOwnProperty.call(item, 'waitingForResponse');
      const inlineImage = item.inlineImage;
      const inlineImageSettled = inlineImage && inlineImage.status === 'done';
      if (!hasWaiting && (!inlineImage || inlineImageSettled)) return item;
      const next = { ...item };
      delete next.waitingForResponse;
      if (inlineImage && !inlineImageSettled) delete next.inlineImage;
      return next;
    });
}

// 已提交消息快照缓存：只有“已提交消息”确实变化时才做整份 JSON.stringify。
// 流式回复期间每个 token 都会更新 messages，但已提交部分没有变（元素仍是
// 同一批对象引用），按引用比对即可跳过无意义的全量序列化，同时保留
// “用户消息一发出就落盘”的原有行为。committed 用于引用比对，persistable
// 仅在实际重算时使用。
export function createPersistableSnapshotCache() {
  let list = [];
  let snapshot = '[]';
  return {
    get(committed, persistable) {
      const current = Array.isArray(committed) ? committed : [];
      const unchanged = current.length === list.length
        && current.every((item, index) => item === list[index]);
      if (unchanged) return snapshot;
      snapshot = JSON.stringify(buildPersistableMessages(persistable));
      list = current;
      return snapshot;
    },
  };
}
