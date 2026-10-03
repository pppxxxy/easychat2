// 阅读器 Markdown 渲染的纯逻辑：书籍格式判定、`react-native-markdown-display`
// 的主题样式工厂、评论摘录。刻意不 import react-native / 组件，供 Node 直测。

// importBook 落库的 format 取值（extractText 由扩展名派生）。
export const MARKDOWN_FORMATS = ['md', 'markdown'];

export function isMarkdownBook(item) {
  const format = String((item && item.format) || '').trim().toLowerCase();
  return MARKDOWN_FORMATS.includes(format);
}

// 评论摘录：Markdown 模式没有分页，直接取当前块的原始文本（保留 Markdown 语法，
// 模型能读；只按字数截断）。纯函数，便于断言。
export function markdownExcerpt(text, maxChars = 600) {
  const source = String(text || '').trim();
  const limit = Math.max(1, Math.floor(Number(maxChars)) || 600);
  return source.slice(0, limit);
}

function scale(base, ratio, minimum = 0) {
  return Math.max(minimum, Math.round(base * ratio));
}

// 样式工厂：字号跟随阅读器缩放，标题/行高按正文比例派生。
// 键名遵循 react-native-markdown-display 的 AST 节点名。
export function createBookMarkdownStyles({ colors = {}, fontSize = 17, lineHeight = 0, tokens = {} } = {}) {
  const base = Number(fontSize) > 0 ? Number(fontSize) : 17;
  const lh = Number(lineHeight) > 0 ? Number(lineHeight) : Math.round(base * 1.75);
  const radius = (tokens.radius && tokens.radius.sm) || 6;
  const mono = 'monospace';
  const text = colors.text;
  const muted = colors.textMuted || colors.text;
  const surface = colors.surfaceAlt || colors.surface;
  const border = colors.surfaceBorder;
  const primary = colors.primary;

  const heading = ratio => ({
    color: text,
    fontSize: scale(base, ratio, base),
    lineHeight: scale(lh, ratio, lh),
    fontWeight: '700',
    marginTop: Math.round(base * 0.4),
    marginBottom: Math.round(base * 0.3),
  });

  return {
    body: { color: text, fontSize: base, lineHeight: lh },
    heading1: heading(1.6),
    heading2: heading(1.4),
    heading3: heading(1.25),
    heading4: heading(1.15),
    heading5: { ...heading(1.05), fontWeight: '700' },
    heading6: { ...heading(1), fontWeight: '700', color: muted },
    paragraph: { marginTop: 0, marginBottom: Math.round(base * 0.5) },
    strong: { fontWeight: '700', color: text },
    em: { fontStyle: 'italic', color: text },
    link: { color: primary },
    hr: { backgroundColor: border, height: 1, marginVertical: Math.round(base * 0.6) },
    blockquote: {
      backgroundColor: surface,
      borderColor: primary,
      borderLeftWidth: 3,
      paddingHorizontal: 10,
      paddingVertical: 4,
      marginVertical: Math.round(base * 0.4),
    },
    bullet_list: { marginVertical: 4 },
    ordered_list: { marginVertical: 4 },
    list_item: { marginVertical: 2 },
    bullet_list_icon: { color: text, marginRight: 6 },
    ordered_list_icon: { color: text, marginRight: 6 },
    bullet_list_content: { flex: 1, color: text },
    ordered_list_content: { flex: 1, color: text },
    code_inline: {
      color: '#c7254e',
      backgroundColor: surface,
      borderWidth: 0,
      borderRadius: radius,
      paddingHorizontal: 4,
      fontFamily: mono,
    },
    code_block: {
      color: text,
      backgroundColor: surface,
      borderWidth: 0,
      borderRadius: radius,
      padding: 10,
      fontFamily: mono,
    },
    fence: {
      color: text,
      backgroundColor: surface,
      borderWidth: 0,
      borderRadius: radius,
      padding: 10,
      fontFamily: mono,
    },
    table: { borderColor: border },
    thead: { borderColor: border },
    tbody: { borderColor: border },
    th: { color: text, borderColor: border, paddingHorizontal: 6, paddingVertical: 4 },
    td: { color: text, borderColor: border, paddingHorizontal: 6, paddingVertical: 4 },
    image: { borderRadius: radius },
  };
}
