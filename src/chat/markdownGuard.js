// Markdown 渲染的输入防护。
//
// 背景：react-native-markdown-display 依赖 markdown-it + linkify-it，后者存在 ReDoS——
// 实测 'http://a.a.a.' 重复约 2 万次（26 万字符）单次渲染耗时 ~3.9 秒，低端机会直接卡死
// （上游无补丁）。渲染层必须自防：给进入 markdown-it 的文本设长度上限，超长则截断并提示，
// 而不是把整段交给它解析。
//
// 纯函数，便于单测，聊天页与预览共用同一上限。

import { tActive } from '../i18n/index.js';

// 单个 Markdown 渲染块的字符上限。正常助手回复远低于此；超过大概率是异常/注入。
export const MAX_MARKDOWN_CHARS = 20000;

// 截断超长文本：返回 { text, truncated }。未超长时原样返回。
export function clampMarkdownText(text, max = MAX_MARKDOWN_CHARS) {
  const source = String(text === null || text === undefined ? '' : text);
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : MAX_MARKDOWN_CHARS;
  if (source.length <= limit) return { text: source, truncated: false };
  return {
    text: `${source.slice(0, limit)}\n\n${tActive('chat.markdown.truncated', { count: source.length - limit })}`,
    truncated: true,
  };
}
