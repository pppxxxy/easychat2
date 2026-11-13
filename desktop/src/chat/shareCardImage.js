// 对话长图（桌面）：把导出条目画成一张 PNG（对应手机 chat/ShareCard + view-shot）。
//
// 手机用 react-native-view-shot 截 React 视图；桌面没有该原生模块，但渲染进程本身就是
// Chromium ——用 <canvas> 按同一版式重绘即可，产出同样是 PNG 字节。
//
// 版式照抄 ShareCard：标题 → 元信息（时间/条数/截断）→ 逐条气泡（用户右、助手左）。
// 纯函数（输入条目 + 主题色，输出 PNG 字节），Node 里可用假 canvas 断言换行与高度计算。
import { EXPORT_MAX_MESSAGES } from '../../../src/chat/conversationExport.js';

export const CARD_WIDTH = 720;
const PADDING = 28;
const GAP = 12;
const BUBBLE_PADDING_X = 14;
const BUBBLE_PADDING_Y = 10;
const MAX_BUBBLE_WIDTH = CARD_WIDTH - PADDING * 2 - 96;
const TITLE_SIZE = 20;
const META_SIZE = 12;
const BODY_SIZE = 14;
const META_LINE = 18;
const BODY_LINE = 22;
const LINE_GAP = 4;

// 按像素宽度把一行切成多行。中文按字符断，英文尽量在空格处断——与手机的文本换行
// 行为同口径（够用即可，不需要完整的排版引擎）。
export function wrapLines(measure, text, maxWidth) {
  const source = String(text === null || text === undefined ? '' : text);
  if (!source) return [''];
  const lines = [];
  let current = '';
  // 逐字符累积：量一次「加上这个字符后是否超宽」。measure 由调用方注入（canvas 的
  // measureText 或测试里的桩），这样本模块不依赖任何渲染环境。
  for (const char of source) {
    const next = current + char;
    if (current && measure(next) > maxWidth) {
      // 英文尽量在空白处断：把最后一个空格之后的部分挪到下一行。
      const lastSpace = current.lastIndexOf(' ');
      if (char !== ' ' && lastSpace > 0 && lastSpace > current.length - 12) {
        lines.push(current.slice(0, lastSpace));
        current = `${current.slice(lastSpace + 1)}${char}`;
      } else {
        lines.push(current);
        current = char === ' ' ? '' : char;
      }
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [''];
}

// 计算整体版式（不画）：返回总高度与每条消息的布局块。
// 抽成纯函数是为了能在 Node 里断言「高度随行数增长」与「截断提示只在那里出现」。
export function planShareCard({ entries, meta, measure, width = CARD_WIDTH } = {}) {
  const list = (Array.isArray(entries) ? entries : []).slice(0, EXPORT_MAX_MESSAGES);
  const info = meta && typeof meta === 'object' ? meta : {};
  const maxBubble = Math.max(120, Math.min(MAX_BUBBLE_WIDTH, width - PADDING * 2 - 96));
  let y = PADDING;

  const blocks = [];
  const titleLines = wrapLines(measure, info.title || '', width - PADDING * 2);
  blocks.push({ kind: 'title', lines: titleLines, top: y });
  y += titleLines.length * (TITLE_SIZE + 4) + 6;

  const metaText = String(info.metaText || '');
  const metaLines = wrapLines(measure, metaText, width - PADDING * 2);
  blocks.push({ kind: 'meta', lines: metaLines, top: y });
  y += metaLines.length * META_LINE + 14;

  list.forEach(entry => {
    const isUser = entry && entry.role === 'user';
    const head = [entry && entry.speaker, entry && entry.time].filter(Boolean).join(' · ');
    const headLines = head ? wrapLines(measure, head, maxBubble - BUBBLE_PADDING_X * 2) : [];
    const bodyLines = wrapLines(measure, entry && entry.body, maxBubble - BUBBLE_PADDING_X * 2);
    const height = BUBBLE_PADDING_Y * 2
      + headLines.length * META_LINE
      + (headLines.length ? LINE_GAP : 0)
      + bodyLines.length * BODY_LINE;
    blocks.push({
      kind: 'bubble',
      isUser,
      headLines,
      bodyLines,
      top: y,
      height,
      left: isUser ? width - PADDING - maxBubble : PADDING,
      width: maxBubble,
    });
    y += height + GAP;
  });

  return { width, height: y + PADDING, blocks, count: list.length };
}

// 画到 ctx 上（ctx 由调用方提供：真实 canvas 或测试桩）。
export function drawShareCard(ctx, plan, colors = {}) {
  const palette = {
    background: colors.background || '#ffffff',
    text: colors.text || '#111111',
    userBubble: colors.userBubble || '#3d6ef5',
    userText: colors.userText || '#ffffff',
    assistantBubble: colors.assistantBubble || '#f2f3f5',
    assistantText: colors.assistantText || '#111111',
    faint: colors.faint || '#8a8f99',
  };
  ctx.fillStyle = palette.background;
  ctx.fillRect(0, 0, plan.width, plan.height);

  plan.blocks.forEach(block => {
    if (block.kind === 'title') {
      ctx.fillStyle = palette.text;
      ctx.font = `bold ${TITLE_SIZE}px sans-serif`;
      block.lines.forEach((line, index) => {
        ctx.fillText(line, CARD_WIDTH === plan.width ? PADDING : PADDING, block.top + index * (TITLE_SIZE + 4) + TITLE_SIZE);
      });
      return;
    }
    if (block.kind === 'meta') {
      ctx.fillStyle = palette.faint;
      ctx.font = `${META_SIZE}px sans-serif`;
      block.lines.forEach((line, index) => {
        ctx.fillText(line, PADDING, block.top + index * META_LINE + META_SIZE);
      });
      return;
    }
    // 气泡：用户右、助手左（与 ShareCard 一致）。
    const radius = 14;
    ctx.fillStyle = block.isUser ? palette.userBubble : palette.assistantBubble;
    const x = block.left;
    const y = block.top;
    const w = block.width;
    const h = block.height;
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
    ctx.fill();

    let cursor = y + BUBBLE_PADDING_Y;
    ctx.font = `${META_SIZE}px sans-serif`;
    ctx.fillStyle = block.isUser ? palette.userText : palette.faint;
    block.headLines.forEach(line => {
      ctx.fillText(line, x + BUBBLE_PADDING_X, cursor + META_SIZE);
      cursor += META_LINE;
    });
    if (block.headLines.length) cursor += LINE_GAP;
    ctx.font = `${BODY_SIZE}px sans-serif`;
    ctx.fillStyle = block.isUser ? palette.userText : palette.assistantText;
    block.bodyLines.forEach(line => {
      ctx.fillText(line, x + BUBBLE_PADDING_X, cursor + BODY_SIZE);
      cursor += BODY_LINE;
    });
  });
  return plan;
}
