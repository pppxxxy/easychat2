export function toggleMessageSelection(selectedIds, messageId) {
  const current = Array.isArray(selectedIds)
    ? selectedIds.map(id => String(id || '')).filter(Boolean)
    : [];
  const id = String(messageId || '');
  if (!id) return current;
  return current.includes(id)
    ? current.filter(selectedId => selectedId !== id)
    : [...current, id];
}

export function removeMessagesByIds(messages, messageIds) {
  const ids = new Set(
    (Array.isArray(messageIds) ? messageIds : [messageIds])
      .map(id => String(id || ''))
      .filter(Boolean)
  );
  return (Array.isArray(messages) ? messages : [])
    .filter(message => !message || !ids.has(String(message.id || '')));
}
