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

// 可进入多选的稳定消息 id：排除生成中的占位消息（pending），与消息 Pressable 的
// disabled 判定保持一致。返回字符串 id 数组，供「全选」使用。
export function selectableMessageIds(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter(message => message && message.id && !message.pending)
    .map(message => String(message.id));
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

export function getEditResendPlan(messages, targetId) {
  const list = Array.isArray(messages) ? messages : [];
  const id = String(targetId || '');
  const index = list.findIndex(message => message && String(message.id || '') === id);
  const target = index >= 0 ? list[index] : null;
  if (!target || target.role !== 'user' || target.image) return null;
  return {
    text: String(target.text || ''),
    messages: list.slice(0, index),
  };
}
