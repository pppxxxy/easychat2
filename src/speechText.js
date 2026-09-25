const VARIANT_STATUS_BAR_PATTERN =
  /(^|\r?\n)[\t ]*【数值状态栏】[\t ]*\r?\n[\t ]*好感度[：:][\t ]*\d+\/200[\t ]*\r?\n[\t ]*心情[：:][\t ]*\d+\/100[\t ]*\r?\n[\t ]*友情[：:][\t ]*\d+\/100[\t ]*(?=\r?\n|$)/g;
const VARIANT_STATUS_LINE_PATTERN =
  /(^|\r?\n)[\t ]*(?:【触碰度】[^\r\n]*|【特殊】[^\r\n]*|(?:心情|友情)[：:][\t ]*\d+\/100[\t ]*)(?=\r?\n|$)/g;

export function hideVariantStatusBar(text) {
  return String(text ?? '')
    .replace(VARIANT_STATUS_BAR_PATTERN, '$1')
    .replace(VARIANT_STATUS_LINE_PATTERN, '$1');
}

const SPEECH_FENCE_PATTERN = /```[\s\S]*?```/g;
const SPEECH_SCRIPT_PATTERN = /<script\b[^>]*>[\s\S]*?<\/script>/gi;
const SPEECH_STYLE_PATTERN = /<style\b[^>]*>[\s\S]*?<\/style>/gi;
const SPEECH_COMMENT_PATTERN = /<!--[\s\S]*?-->/g;
const SPEECH_HTML_TAG_PATTERN = /<[^>]*>/g;
const SPEECH_IMAGE_PATTERN = /!\[[^\]]*\]\([^)]*\)/g;
const SPEECH_LINK_PATTERN = /\[([^\]]*)\]\([^)]*\)/g;
const SPEECH_HR_PATTERN = /^[ \t]{0,3}(?:-[ \t]*){3,}$/gm;
const SPEECH_HEADING_PATTERN = /^[ \t]{0,3}#{1,6}[ \t]*/gm;
const SPEECH_HEADING_TRAILING_PATTERN = /[ \t]+#{1,6}[ \t]*$/gm;
const SPEECH_QUOTE_PATTERN = /^[ \t]{0,3}>[ \t]?/gm;
const SPEECH_LIST_PATTERN = /^[ \t]{0,3}(?:[-*+]|\d+[.)])[ \t]+/gm;
const SPEECH_INLINE_CODE_PATTERN = /`([^`]+)`/g;
const SPEECH_EMPHASIS_PATTERN = /(\*\*|__|~~|\*|_)/g;

export function toSpeechText(text) {
  let out = hideVariantStatusBar(text);
  out = out.replace(SPEECH_FENCE_PATTERN, ' ');
  out = out.replace(SPEECH_SCRIPT_PATTERN, ' ');
  out = out.replace(SPEECH_STYLE_PATTERN, ' ');
  out = out.replace(SPEECH_COMMENT_PATTERN, ' ');
  out = out.replace(SPEECH_HTML_TAG_PATTERN, ' ');
  out = out.replace(SPEECH_IMAGE_PATTERN, '');
  out = out.replace(SPEECH_LINK_PATTERN, '$1');
  out = out.replace(SPEECH_HR_PATTERN, ' ');
  out = out.replace(SPEECH_HEADING_PATTERN, '');
  out = out.replace(SPEECH_HEADING_TRAILING_PATTERN, '');
  out = out.replace(SPEECH_QUOTE_PATTERN, '');
  out = out.replace(SPEECH_LIST_PATTERN, '');
  out = out.replace(SPEECH_INLINE_CODE_PATTERN, '$1');
  out = out.replace(SPEECH_EMPHASIS_PATTERN, '');
  out = out.replace(/\r\n/g, '\n');
  return out
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}