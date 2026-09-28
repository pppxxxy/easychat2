import { Platform } from 'react-native';
import { HTMLContentModel, HTMLElementModel } from 'react-native-render-html';

import { stripMarkdownFences } from './richHtml.js';

// 助手正文渲染的共享配置与预处理：聊天页与制卡预览共用，
// 保证「预览里的 Markdown/HTML/正则效果」与真实聊天完全一致。纯配置与纯函数，无 JSX。

export const MONO_FONT = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

export const createMarkdownStyles = (theme, fonts, tokens) => ({
  body: { color: theme.colors.bubbleAssistantText, fontSize: fonts.scaled(15), lineHeight: fonts.scaled(22) },
  heading1: { color: theme.colors.bubbleAssistantText },
  heading2: { color: theme.colors.bubbleAssistantText },
  heading3: { color: theme.colors.bubbleAssistantText },
  heading4: { color: theme.colors.bubbleAssistantText },
  heading5: { color: theme.colors.bubbleAssistantText },
  heading6: { color: theme.colors.bubbleAssistantText },
  hr: { backgroundColor: theme.colors.surfaceBorder },
  blockquote: { backgroundColor: theme.colors.surfaceAlt, borderColor: theme.colors.primary },
  code_inline: {
    color: '#c7254e',
    backgroundColor: theme.colors.surfaceAlt,
    borderWidth: 0,
    borderRadius: tokens.radius.xs,
    paddingHorizontal: tokens.spacing.xs + 1,
    paddingVertical: tokens.spacing.xs / 4,
    fontFamily: MONO_FONT,
  },
  code_block: {
    color: theme.colors.bubbleAssistantText,
    backgroundColor: theme.colors.surfaceAlt,
    borderWidth: 0,
    borderRadius: tokens.radius.sm,
    padding: tokens.spacing.sm + 2,
    fontFamily: MONO_FONT,
  },
  fence: {
    color: theme.colors.bubbleAssistantText,
    backgroundColor: theme.colors.surfaceAlt,
    borderWidth: 0,
    borderRadius: tokens.radius.sm,
    padding: tokens.spacing.sm + 2,
    fontFamily: MONO_FONT,
  },
  link: { color: theme.colors.primary },
  bullet_list_icon: { color: theme.colors.bubbleAssistantText },
  ordered_list_icon: { color: theme.colors.bubbleAssistantText },
  bullet_list_content: { flex: 1, color: theme.colors.bubbleAssistantText },
  ordered_list_content: { flex: 1, color: theme.colors.bubbleAssistantText },
});

const STYLE_BLOCK_PATTERN = /<style\b[^>]*>[\s\S]*?<\/style>/gi;
const BUTTON_BLOCK_PATTERN = /<button\b([^>]*)>([\s\S]*?)<\/button>/gi;
const ONCLICK_ATTRIBUTE_PATTERN = /onclick\s*=\s*("[^"]*"|'[^']*')/i;
const SLASH_SEND_PATTERN = /\/send\s+([^'"]+)/i;
const GRADIENT_DECLARATION_PATTERN = /(?:background(?:-image)?)\s*:\s*(?:repeating-)?(?:linear|radial)-gradient\(((?:[^()]|\([^()]*\))*)\)/gi;
const GRADIENT_COLOR_STOP_PATTERN = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/;

export const createHtmlBaseStyle = (theme, fonts) => ({
  color: theme.colors.bubbleAssistantText,
  fontSize: fonts.scaled(15),
  lineHeight: fonts.scaled(22),
});

export const createHtmlTagsStyles = (theme, fonts) => ({
  a: { color: theme.colors.primary },
  code: { fontFamily: MONO_FONT, color: '#c7254e', backgroundColor: theme.colors.surfaceAlt },
  pre: { fontFamily: MONO_FONT, color: theme.colors.bubbleAssistantText, backgroundColor: theme.colors.surfaceAlt },
  q: { color: theme.colors.bubbleAssistantText },
  h4: { color: theme.colors.bubbleAssistantText, fontSize: fonts.scaled(13), marginTop: 0, marginBottom: 6 },
});

const PANEL_CLASS_STYLES = {
  'ml-open-panel':
    'margin-top:14px;padding:14px;border-radius:10px;background-color:#eef5f3;border-width:1px;border-color:#cfd8dc',
  'ml-open-head': 'margin-bottom:8px',
  'ml-open-grid': '',
  'ml-open-group':
    'margin-top:8px;padding:10px;border-radius:9px;background-color:#ffffff;border-width:1px;border-color:#dde5e8',
};

export const regexClassesStyles = {
  'ml-course-ui': { marginTop: 18, marginBottom: 10, borderWidth: 1, borderColor: 'rgba(52,79,93,0.22)', borderRadius: 8, backgroundColor: '#fbfcfd', overflow: 'hidden', color: '#24343d' },
  'ml-course-head': { paddingVertical: 10, paddingHorizontal: 12, backgroundColor: '#344f5d', color: '#fff' },
  'ml-course-title': { fontWeight: '700', color: '#fff' },
  'ml-course-day': { fontSize: 12, color: '#fff', backgroundColor: 'rgba(255,255,255,0.16)' },
  'ml-course-list': { paddingVertical: 4 },
  'ml-course-row': { paddingVertical: 8, paddingHorizontal: 12, borderTopWidth: 1, borderTopColor: 'rgba(55,78,91,0.12)', fontSize: 13, lineHeight: 18 },
  'ml-course-number': { fontStyle: 'normal', fontWeight: '700', color: '#344f5d', backgroundColor: '#dbe8ec', marginBottom: 4 },
  'ml-course-time': { color: '#48636f', fontSize: 12, marginBottom: 4 },
  'ml-course-subject': { color: '#24343d', fontSize: 13, fontWeight: '700', marginBottom: 4 },
  'ml-course-detail': { color: '#60737b', fontSize: 13 },
  'ml-course-empty': { paddingVertical: 14, paddingHorizontal: 16, color: '#60737b', fontSize: 13, lineHeight: 21 },
  'ml-prose-safe': { marginTop: 12, paddingVertical: 17, paddingHorizontal: 15, borderRadius: 8, borderWidth: 1, borderColor: 'rgba(65,88,96,0.18)', backgroundColor: '#fbfcfb', color: '#26343a', fontSize: 14.5, lineHeight: 27, whiteSpace: 'pre' },
  'ml-quote': { color: '#8b4052', fontWeight: '600' },
  'ml-strong': { color: '#243139', fontWeight: '800', backgroundColor: 'rgba(159,63,85,0.22)' },
};

export const regexDomVisitors = {
  onElement(element) {
    const parentClasses = (element.parent?.attribs?.class || '').split(/\s+/);
    const rowClass = { em: 'ml-course-number', time: 'ml-course-time', strong: 'ml-course-subject', span: 'ml-course-detail' };
    const headClass = { span: 'ml-course-title', b: 'ml-course-day' };
    const className = parentClasses.includes('ml-course-row')
      ? rowClass[element.name]
      : parentClasses.includes('ml-course-head') ? headClass[element.name] : null;
    if (!className) return;
    element.attribs.class = `${element.attribs.class || ''} ${className}`.trim();
    if (parentClasses.includes('ml-course-row')) element.name = 'div';
  },
};

export const customHTMLElementModels = {
  time: HTMLElementModel.fromCustomModel({ tagName: 'time', contentModel: HTMLContentModel.textual }),
  button: HTMLElementModel.fromCustomModel({
    tagName: 'button',
    contentModel: HTMLContentModel.block,
  }),
};

function extractSendCommand(onclick) {
  const match = String(onclick || '').match(SLASH_SEND_PATTERN);
  return match ? match[1].trim() : '';
}

// 按钮 renderer 需要从 tnode 里取出按钮文案，聊天页与预览共用。
export function collectTNodeText(node) {
  if (!node) return '';
  if (node.type === 'text') return node.data || '';
  if (Array.isArray(node.children)) return node.children.map(collectTNodeText).join('');
  return '';
}

function solidColorFromGradient(stops) {
  const match = String(stops || '').match(GRADIENT_COLOR_STOP_PATTERN);
  return match ? match[0] : '';
}

function replaceGradientBackgrounds(html) {
  return String(html || '').replace(GRADIENT_DECLARATION_PATTERN, (full, stops) => {
    const color = solidColorFromGradient(stops);
    return color ? `background-color: ${color}` : 'background-color: transparent';
  });
}

// 助手 HTML 预处理：剥围栏/样式块、把不支持的渐变降级成纯色、把按钮 onclick 换成 data-command。
export function prepareAssistantHtml(raw) {
  let html = stripMarkdownFences(raw).replace(STYLE_BLOCK_PATTERN, '');
  html = replaceGradientBackgrounds(html);
  html = html.replace(/class="(ml-open-[a-z]+)"/g, (full, cls) => {
    const inline = PANEL_CLASS_STYLES[cls];
    return inline ? `style="${inline}"` : full;
  });
  if (!/<button\b/i.test(html)) return html;
  return html.replace(BUTTON_BLOCK_PATTERN, (full, attrs, label) => {
    const onclickMatch = attrs.match(ONCLICK_ATTRIBUTE_PATTERN);
    const onclick = onclickMatch ? onclickMatch[1].slice(1, -1) : '';
    const command = extractSendCommand(onclick);
    const dataCommand = command ? encodeURIComponent(command) : '';
    const cleanAttrs = attrs.replace(ONCLICK_ATTRIBUTE_PATTERN, '').trim();
    const attrPrefix = cleanAttrs ? ` ${cleanAttrs}` : '';
    return `<button${attrPrefix} data-command="${dataCommand}">${label}</button>`;
  });
}
