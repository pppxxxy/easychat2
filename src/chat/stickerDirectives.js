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

// 表情包教学提示（模型可见的提示词，刻意不进 i18n；开关开启且有表情包时注入系统提示）。
// 措辞可改。清单为空时返回空串——调用方据此不注入（无表情包就不该发指令）。
const STICKER_INSTRUCTION_TEMPLATE = [
  '你可以在情绪合适时用表情包回应。想发表情包时，在回复里单独写一行：[[表情包:名称]]，',
  '名称必须严格从下列清单中选择：{names}。',
  '不要自造、改写或翻译名称；也不要在每条回复里都发表情包，只在情绪真正贴合时偶尔使用。',
].join('\n');

export function buildStickerInstruction(names) {
  const list = (Array.isArray(names) ? names : []).map(cleanName).filter(Boolean);
  if (list.length === 0) return '';
  // 用替换函数而非替换字符串：表情包名可含 `$&`/`$1` 等模式，作为替换字符串会被解释成注入。
  return STICKER_INSTRUCTION_TEMPLATE.replace('{names}', () => list.join('、'));
}
