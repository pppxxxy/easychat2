// data URI 解析与多模态消息块转换。纯函数。

export function parseDataUri(uri) {
  const match = /^data:([^;,]+)?((?:;[^,]*)*),(.*)$/s.exec(String(uri || ''));
  if (!match) return null;
  const params = String(match[2] || '');
  const isBase64 = /;base64/i.test(params);
  return {
    mediaType: String(match[1] || 'image/jpeg'),
    isBase64,
    data: String(match[3] || ''),
  };
}

export function toAnthropicImagePart(part) {
  const url = String((part.image_url && part.image_url.url) || '');
  const parsed = parseDataUri(url);
  if (parsed && parsed.isBase64) {
    return { type: 'image', source: { type: 'base64', media_type: parsed.mediaType, data: parsed.data } };
  }
  return { type: 'image', source: { type: 'url', url } };
}

export function toTextParts(content, textType = 'text') {
  if (typeof content === 'string') return [{ type: textType, text: content }];
  if (!Array.isArray(content)) return [];
  return content
    .map(part => {
      if (typeof part === 'string') return { type: textType, text: part };
      if (part && typeof part.text === 'string') return { type: textType, text: part.text };
      return null;
    })
    .filter(Boolean);
}
