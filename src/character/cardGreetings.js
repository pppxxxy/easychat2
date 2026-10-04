// 角色卡开场白的整理与导入决策（纯函数，便于单测）。

function clean(value) {
  return String(value == null ? '' : value).trim();
}

// 把卡片的 firstMes + alternateGreetings 整理成候选列表。
export function listGreetingCandidates(fields) {
  const source = fields && typeof fields === 'object' ? fields : {};
  const list = [];
  const first = clean(source.firstMes);
  if (first) list.push({ text: first, source: 'first' });
  const alternates = Array.isArray(source.alternateGreetings) ? source.alternateGreetings : [];
  alternates.forEach(item => {
    const text = clean(item);
    if (text) list.push({ text, source: 'alt' });
  });
  return list;
}

// 由「可编辑的草稿数组 + 选中下标」得到要写入角色的开场白字段。
// selectedIndex < 0 表示不使用开场白（firstMes 置空），其余非空草稿保留为备用开场白。
export function isGreetingMessage(message, sessionId) {
  return !!message
    && message.role === 'assistant'
    && (message.kind === 'greeting' || message.id === `greeting-${sessionId}`);
}

export function buildGreetingImport(drafts, selectedIndex) {
  const list = (Array.isArray(drafts) ? drafts : []).map(clean);
  const useNone = !(Number.isInteger(selectedIndex) && selectedIndex >= 0 && selectedIndex < list.length);
  const firstMes = useNone ? '' : (list[selectedIndex] || '');
  const alternateGreetings = list.filter((text, index) => text && (useNone || index !== selectedIndex));
  return { firstMes, alternateGreetings };
}

// 删除第 index 条草稿后，重算仍应选中的下标（纯函数，便于单测）。
// remainingLength 为删除后剩余条数：删中的那条回落到第一条（还有剩余）或 -1（删空）；
// 被删项之前的选中位不变，之后的选中位左移一位；未选中（-1）保持 -1。
export function removeGreetingDraftIndex(selectedIndex, index, remainingLength) {
  const prev = Number.isInteger(selectedIndex) ? selectedIndex : -1;
  if (prev === index) return remainingLength > 0 ? 0 : -1;
  if (prev > index) return prev - 1;
  return prev;
}
