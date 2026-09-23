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
export function buildGreetingImport(drafts, selectedIndex) {
  const list = (Array.isArray(drafts) ? drafts : []).map(clean);
  const useNone = !(Number.isInteger(selectedIndex) && selectedIndex >= 0 && selectedIndex < list.length);
  const firstMes = useNone ? '' : (list[selectedIndex] || '');
  const alternateGreetings = list.filter((text, index) => text && (useNone || index !== selectedIndex));
  return { firstMes, alternateGreetings };
}
