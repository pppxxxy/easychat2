// iframe 高度换算（纯函数，Node 可测）。
//
// 三个边界：
//   1. 内容高度量到多少就显示多少（下限 24px，避免空卡片塌成一条线）；
//   2. 超过共享层的滚动阈值（6000px）收成 480px 预览高度，卡片内部滚动，
//      否则一张长表会把整个聊天列表撑爆；
//   3. 拿不到 contentDocument（沙箱策略变化）时退化为固定 360px + 内部滚动。
import {
  RICH_HTML_MAX_RENDER_HEIGHT,
  RICH_HTML_SCROLL_PREVIEW_HEIGHT,
  RICH_HTML_SCROLL_THRESHOLD,
} from '../../../src/chat/richHtml.js';

export const RICH_HTML_FALLBACK_HEIGHT = 360;

export function contentHeightFrom(scrollHeight, offsetHeight) {
  const raw = Math.max(Number(scrollHeight) || 0, Number(offsetHeight) || 0);
  return Math.min(RICH_HTML_MAX_RENDER_HEIGHT, Math.max(24, Math.ceil(raw)));
}

export function resolveFrameDisplayHeight(measured, accessible = true) {
  if (!accessible) return RICH_HTML_FALLBACK_HEIGHT;
  const bounded = contentHeightFrom(measured, measured);
  return bounded >= RICH_HTML_SCROLL_THRESHOLD ? RICH_HTML_SCROLL_PREVIEW_HEIGHT : bounded;
}

export default resolveFrameDisplayHeight;
