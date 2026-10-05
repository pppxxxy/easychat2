export function shouldIndexSession(session) {
  return !!session
    && String(session.type || 'single') !== 'group'
    && !!String(session.characterId || '');
}

export function getVectorOwnerId(session, fallback = '') {
  if (session && !shouldIndexSession(session)) return '';
  // 不设 'default' 兜底：'default' 是内置 EasyChat2 助手的角色 id，用它兜底会让无归属的
  // 索引沉淀进助手的桶里，任何助手会话都能召回别人的记忆。无归属直接返回空（不读不写）。
  return String((session && session.characterId) || fallback || '');
}
