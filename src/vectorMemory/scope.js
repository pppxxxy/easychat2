export function shouldIndexSession(session) {
  return !!session
    && String(session.type || 'single') !== 'group'
    && !!String(session.characterId || '');
}

export function getVectorOwnerId(session, fallback = '') {
  if (session && !shouldIndexSession(session)) return '';
  return String((session && session.characterId) || fallback || 'default');
}
