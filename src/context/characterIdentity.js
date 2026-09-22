// 角色 id 的稳定化：空 id / 撞 id 时分配唯一 id。
// 抽成零依赖纯函数，便于单测；存储层只负责落盘。

export function makeCharacterId(now = Date.now()) {
  return `card-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function uniqueCharacterId(base, used, now = Date.now()) {
  const seed = String(base || '').trim();
  if (!seed) {
    let candidate = makeCharacterId(now);
    while (used.has(candidate)) candidate = makeCharacterId(now);
    return candidate;
  }
  let bump = 1;
  let candidate = `${seed}-${bump}`;
  while (used.has(candidate)) {
    bump += 1;
    candidate = `${seed}-${bump}`;
  }
  return candidate;
}

// 给角色分配稳定且唯一的 id：defaultId 优先留给 isInitial(item) 为真的那一个；
// 空 id / 重复 id 生成新 id。changed=true 表示结果与输入不同，调用方必须落盘固化——
// 否则每次读取都会按当时的顺序（置顶 / lastUsedAt）重算，角色身份就会漂移。
export function assignStableCharacterIds(list, { defaultId, isInitial, now = Date.now() } = {}) {
  const items = Array.isArray(list) ? list : [];
  const initial = typeof isInitial === 'function' ? isInitial : () => false;
  let defaultIndex = items.findIndex(item => item && item.id === defaultId && initial(item));
  if (defaultIndex < 0) {
    defaultIndex = items.findIndex(item => item && item.id === defaultId);
  }

  const used = new Set();
  let changed = false;
  const result = items.map((item, index) => {
    const current = item && typeof item === 'object' ? item : {};
    let id = String(current.id == null ? '' : current.id).trim();
    const mustReassign = !id
      || (defaultId && id === defaultId && index !== defaultIndex)
      || used.has(id);
    if (mustReassign) {
      id = uniqueCharacterId(id === defaultId ? '' : id, used, now);
      changed = true;
    }
    used.add(id);
    return id === current.id ? current : { ...current, id };
  });
  return { list: result, changed };
}
