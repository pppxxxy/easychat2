// 工作区文件预览分类（纯函数，可 Node 直测）。
//
// 预览面板默认按文件类型渲染：Markdown / HTML 交给聊天页同款的 AssistantMessageBody
// 渲染（与助手消息一致的排版），其余按纯文本展示。分类只看扩展名——不做内容嗅探，
// 避免把 .txt 里的 `#` 误当标题。

const MARKDOWN_EXT = new Set(['md', 'markdown', 'mdown', 'mkd', 'mkdn', 'mdx']);
const HTML_EXT = new Set(['html', 'htm', 'xhtml']);

// 取小写扩展名（无扩展名/隐藏文件 → 空串）。只看最后一个点之后的片段。
export function fileExtension(path) {
  const name = String(path == null ? '' : path);
  const base = name.slice(name.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

// 'markdown' | 'html' | 'text'。
export function previewMode(path) {
  const ext = fileExtension(path);
  if (MARKDOWN_EXT.has(ext)) return 'markdown';
  if (HTML_EXT.has(ext)) return 'html';
  return 'text';
}

// 是否走渲染预览（Markdown / HTML）。false 时按纯文本展示（源码、JSON、日志等）。
export function isRichPreview(path) {
  return previewMode(path) !== 'text';
}
