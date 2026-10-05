export function shouldIndexSession(session) {
  return !!session
    && String(session.type || 'single') !== 'group'
    && !!String(session.characterId || '');
}

export function getVectorOwnerId(session, fallback = '') {
  if (session && !shouldIndexSession(session)) return '';
  // 不再兜底 'default'：无主分段必须显式跳过（所有调用方都对空值有守卫），
  // 否则丢归属的数据会静默沉淀进初始助手的桶——那是跨会话串记忆的温床
  //（2026-10-05 审核报告：default 桶五重污染的第一条）。
  return String((session && session.characterId) || fallback || '');
}
