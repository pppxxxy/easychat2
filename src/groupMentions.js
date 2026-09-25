// 群聊提及解析（纯函数，便于单测；不引入 api/storage）。
export const EVERYONE_MENTION = '全体';
export const MENTION_PREFIX = '@';

export function hasEveryoneMention(text) {
  return String(text || '').includes(`${MENTION_PREFIX}${EVERYONE_MENTION}`);
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 角色名存在前缀包含关系时（如 Al / Alice），必须按完整 mention token 匹配，
// 否则 @Alice 会同时命中 Al。
export function parseMentions(text, characters) {
  const source = String(text || '');
  const list = (Array.isArray(characters) ? characters : []).filter(Boolean);
  if (hasEveryoneMention(source)) {
    return list
      .map(character => (character && character.id != null ? String(character.id) : ''))
      .filter(Boolean);
  }
  const matched = new Set();
  const names = list
    .map(character => ({
      id: character && character.id,
      name: String((character && character.name) || '').trim(),
    }))
    .filter(item => item.id !== null && item.id !== undefined && item.name)
    .sort((a, b) => b.name.length - a.name.length);
  for (const item of names) {
    const pattern = new RegExp(
      `@${escapeRegExp(item.name)}(?=$|[\\s,，。！？!?、;；:：)）\\]}»]|@)`,
      'u'
    );
    if (pattern.test(source)) matched.add(String(item.id));
  }
  return list
    .map(character => (character && character.id != null ? String(character.id) : ''))
    .filter(id => id && matched.has(id));
}