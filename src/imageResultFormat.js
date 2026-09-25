const FORMAT_BY_MIME = {
  'image/png': { ext: 'png', mime: 'image/png' },
  'image/jpeg': { ext: 'jpg', mime: 'image/jpeg' },
  'image/jpg': { ext: 'jpg', mime: 'image/jpeg' },
  'image/webp': { ext: 'webp', mime: 'image/webp' },
  'image/gif': { ext: 'gif', mime: 'image/gif' },
};

const FORMAT_BY_EXT = {
  png: { ext: 'png', mime: 'image/png' },
  jpg: { ext: 'jpg', mime: 'image/jpeg' },
  jpeg: { ext: 'jpg', mime: 'image/jpeg' },
  webp: { ext: 'webp', mime: 'image/webp' },
  gif: { ext: 'gif', mime: 'image/gif' },
};

// 生图结果未必是 PNG：URL 后缀或返回的 mimeType 更可信，避免把 JPEG/WebP 存成 .png 后分享失败。
export function resolveImageFormat(result) {
  const source = result && typeof result === 'object' ? result : {};
  const mime = String(source.mimeType || source.mime || '').toLowerCase().trim();
  if (FORMAT_BY_MIME[mime]) return FORMAT_BY_MIME[mime];
  const url = String(source.url || '').split('?')[0].split('#')[0];
  const match = url.match(/\.([a-z0-9]+)$/i);
  if (match && FORMAT_BY_EXT[match[1].toLowerCase()]) {
    return FORMAT_BY_EXT[match[1].toLowerCase()];
  }
  return { ext: 'png', mime: 'image/png' };
}