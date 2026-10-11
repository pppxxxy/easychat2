// 「隐私与安全 → 单角色锁」角色列表的名字搜索（纯函数，Node 直测）。
// 角色很多时，在长列表里一直往下翻很费劲；这里按名字做大小写不敏感的子串过滤。
// 空查询原样返回，保证「未搜索」时列表与顺序完全不变。

export function filterCharactersByName(list, query) {
  const source = Array.isArray(list) ? list : [];
  const text = String(query == null ? '' : query).trim().toLowerCase();
  if (!text) return source;
  return source.filter(item => {
    if (!item || typeof item !== 'object') return false;
    const name = String(item.name || '').toLowerCase();
    if (name.includes(text)) return true;
    // 未命名角色在列表里回退显示 id，搜索也应能按 id 命中。
    return String(item.id || '').toLowerCase().includes(text);
  });
}
