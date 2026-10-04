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

  // 只有真正剥离了指令才做空白收敛：否则（用户有表情包但本条回复没用到）
  // 会把正常 Markdown 的缩进、空行、行尾双空格一并改坏。
  if (stickers.length === 0) return { text: source, stickers };
  return {
    text: normalizeDirectiveWhitespace(stripped),
    stickers,
  };
}

// 剥离指令后可能留下成片空行，仅收敛多余空行。刻意不动行尾空格（Markdown 硬换行）
// 与整体缩进：同一条回复里既有指令又有正常 Markdown 时，不能连带改坏正文。
function normalizeDirectiveWhitespace(text) {
  return String(text || '').replace(/\n{3,}/g, '\n\n');
}
