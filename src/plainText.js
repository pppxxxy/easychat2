const HTML_TAG_PATTERN = /<\/?(?:div|span|blockquote|q|section|article|details|summary|table|thead|tbody|tr|td|th|ul|ol|li|p|h[1-6]|hr|br|b|i|u|strong|em|font|img|a|code|pre|audio|video|style|script|svg|main|form|button|input|textarea|label|select|option|canvas|iframe)\b[^>]*>/i;

export function containsHtml(text) {
  return HTML_TAG_PATTERN.test(String(text || ''));
}

export function toPlainText(text) {
  let out = String(text || '');
  out = out.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  out = out.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
  out = out.replace(/<!--[\s\S]*?-->/g, '');
  out = out.replace(/<br\s*\/?>/gi, '\n');
  out = out.replace(/<\/(?:p|div|h[1-6]|li|tr|section|article)>/gi, '\n');
  out = out.replace(/<[^>]+>/g, '');
  out = out.replace(/&nbsp;/gi, ' ');
  out = out.replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
  out = out.replace(/&quot;/gi, '"').replace(/&#39;/gi, "'");
  out = out.replace(/&amp;/gi, '&');
  out = out.replace(/\n{3,}/g, '\n\n');
  return out.trim();
}

export function messageCopyText(text) {
  return containsHtml(text) ? toPlainText(text) : String(text || '');
}
