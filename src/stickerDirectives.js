// 角色发表情包：解析助手回复里的 `[[表情包:名称]]` 指令。
//
// 设计约束：
// - 只依赖纯文本处理，便于单测与在纯 Node 环境运行；
// - 名称必须命中白名单（用户实际拥有的表情包），模型自造的名称一律丢弃；
// - 标记从正文中剥离，文字与表情包分别成条展示。

const STICKER_DIRECTIVE_PATTERN = /\[\[\s*表情包\s*[:：]\s*([^\]\n]+?)\s*\]\]/g;

function cleanName(value) {
  return String(value === null || value === undefined ? '' : value).trim();
}

// 可用名称清单：去重、trim、过滤空串，保持输入顺序。
export function resolveStickerNames(stickers) {
  const names = [];
  const seen = new Set();
  (Array.isArray(stickers) ? stickers : []).forEach(sticker => {
    const name = cleanName(sticker && sticker.name);
    if (!name || seen.has(name)) return;
    seen.add(name);
    names.push(name);
  });
  return names;
}

// 解析助手回复：返回剥离标记后的正文，以及命中的（白名单内）表情包名称数组。
// 白名单为空时不做任何解析，原样返回（避免无表情包时误伤正文）。
export function extractStickerDirectives(text, names) {
  const source = String(text === null || text === undefined ? '' : text);
  const allowed = new Set(
    (Array.isArray(names) ? names : []).map(cleanName).filter(Boolean)
  );
  if (allowed.size === 0) return { text: source, stickers: [] };

  const stickers = [];
  const stripped = source.replace(STICKER_DIRECTIVE_PATTERN, (match, rawName) => {
    const name = cleanName(rawName);
    if (!allowed.has(name)) return match;
    stickers.push(name);
    return '';
  });

  return {
    text: normalizeDirectiveWhitespace(stripped),
    stickers,
  };
}

// 剥离标记后可能留下空行或行尾的多余空格，收敛为整齐的段落。
function normalizeDirectiveWhitespace(text) {
  return String(text || '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+|\s+$/g, '');
}
