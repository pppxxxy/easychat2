// 助手回复里的「下载网络图片」指令：`<download_image:URL>`。
//
// 设计约束（与表情包指令同一纪律）：纯文本处理、零 RN 依赖、Node 可直测；
// 只认 http/https；去重并限量，避免模型一口气塞几十个 URL 把 App 拖垮。
// 本模块**只解析**，真正的下载/落盘在 chat 域封装（attachments.js 的 downloadRemoteImage）。

const DOWNLOAD_IMAGE_DIRECTIVE_PATTERN = /<\s*download_image\s*:\s*(https?:\/\/[^<>\s]+)\s*>/gi;

// 一条回复最多下载的图片数：超出的指令同样被剥离（不残留原文），只是不下载。
export const MAX_DOWNLOAD_IMAGES = 3;

export function isHttpImageUrl(url) {
  return /^https?:\/\//i.test(String(url || '').trim());
}

// 解析助手回复：返回剥离标记后的正文，以及去重后的 URL 列表（最多 MAX_DOWNLOAD_IMAGES 个）。
// 未命中任何指令时原样返回，避免误伤正常正文（含 Markdown 缩进/空行）。
export function extractDownloadImageDirectives(text) {
  const source = String(text === null || text === undefined ? '' : text);
  const urls = [];
  const seen = new Set();
  const stripped = source.replace(DOWNLOAD_IMAGE_DIRECTIVE_PATTERN, (match, rawUrl) => {
    const url = String(rawUrl || '').trim();
    if (!isHttpImageUrl(url)) return match;
    if (!seen.has(url) && urls.length < MAX_DOWNLOAD_IMAGES) {
      seen.add(url);
      urls.push(url);
    }
    return '';
  });
  if (urls.length === 0) return { text: source, urls: [] };
  return { text: normalizeDirectiveWhitespace(stripped), urls };
}

// 剥离指令后可能留下成片空行，仅收敛多余空行，不动行尾空格与整体缩进。
function normalizeDirectiveWhitespace(text) {
  return String(text || '').replace(/\n{3,}/g, '\n\n');
}
