// 角色库列表的派生逻辑（纯函数，Node 直测）。
//
// 搜索口径与 Android CharacterLibraryScreen 一致：名称、描述、标签都参与匹配，
// 忽略大小写与首尾空白；空查询返回全部（不做「空查询=无结果」的歧义）。
// 排序：置顶在前，其余保持存储顺序（不按字母重排——用户自己的排列更有意义）。

function normalizeQuery(query) {
  return String(query === undefined || query === null ? '' : query).trim().toLowerCase();
}

function tagsOf(character) {
  const tags = character && Array.isArray(character.tags) ? character.tags : [];
  return tags.map(tag => String(tag || '')).filter(Boolean).join(' ').toLowerCase();
}

export function characterMatchesQuery(character, query) {
  // 先判条目本身：空查询放行的是「真实角色」，不是数组里的空位
  //（否则 filterCharacters 会把 null 一起交给渲染层，卡片直接崩）。
  if (!character) return false;
  const needle = normalizeQuery(query);
  if (!needle) return true;
  const haystack = [
    String(character.name || ''),
    String(character.description || ''),
    String(character.scenario || ''),
  ].join(' ').toLowerCase();
  return haystack.includes(needle) || tagsOf(character).includes(needle);
}

export function filterCharacters(characters, query) {
  return (Array.isArray(characters) ? characters : [])
    .filter(character => characterMatchesQuery(character, query));
}

// 置顶优先，其余保持原顺序。稳定性用「原索引」兜底，避免 sort 实现差异导致抖动。
export function sortCharacters(characters) {
  return (Array.isArray(characters) ? characters : [])
    .map((character, index) => ({ character, index }))
    .sort((a, b) => {
      const pinnedA = a.character && a.character.pinned === true ? 1 : 0;
      const pinnedB = b.character && b.character.pinned === true ? 1 : 0;
      if (pinnedA !== pinnedB) return pinnedB - pinnedA;
      return a.index - b.index;
    })
    .map(item => item.character);
}

// 卡片副标题：优先描述，其次人设，最后场景；压成单行并截断到 limit 字。
export function characterSummary(character, limit = 80) {
  const source = character && typeof character === 'object' ? character : {};
  const raw = [source.description, source.personality, source.scenario]
    .map(value => String(value || '').replace(/\s+/g, ' ').trim())
    .find(Boolean) || '';
  const max = Math.max(8, Math.trunc(Number(limit) || 80));
  return raw.length > max ? `${raw.slice(0, max)}…` : raw;
}