import { DEFAULT_CHARACTER, sortCharacters } from '../storage/characters.js';

export function resolveActiveId(list, activeId) {
  if (activeId && list.some(character => character.id === activeId)) {
    return activeId;
  }
  const fallback = list.find(character => character.id === DEFAULT_CHARACTER.id);
  return fallback ? fallback.id : DEFAULT_CHARACTER.id;
}

export function uniqueId(base, list) {
  let id = String(base || '').trim() || `card-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  if (!list.some(character => character.id === id)) return id;
  let suffix = 2;
  while (list.some(character => character.id === `${id}-${suffix}`)) {
    suffix += 1;
  }
  return `${id}-${suffix}`;
}

export function withUpdatedCharacter(list, activeId, patch) {
  const active = list.find(character => character.id === activeId) || DEFAULT_CHARACTER;
  const resolvedPatch = typeof patch === 'function' ? patch(active) : patch;
  const merged = { ...active, ...(resolvedPatch || {}), id: active.id };
  const next = sortCharacters(
    list.map(character => (character.id === merged.id ? merged : character))
  );
  return { list: next, character: merged };
}

export function withSwitchedCharacter(list, id, now) {
  const target = list.find(character => character.id === id);
  if (!target) {
    return { list, character: null, found: false };
  }
  const touched = { ...target, lastUsedAt: now };
  const next = sortCharacters(
    list.map(character => (character.id === id ? touched : character))
  );
  return { list: next, character: touched, found: true };
}

export function withAddedCharacter(list, character, now) {
  const next = {
    ...DEFAULT_CHARACTER,
    ...character,
    id: uniqueId(character && character.id, list),
    // 新增角色永远不是初始卡；显式清掉从 DEFAULT_CHARACTER 继承来的 builtin 标记。
    builtin: false,
    lastUsedAt: now,
  };
  return { list: sortCharacters([...list, next]), character: next };
}

export function withDeletedCharacter(list, id, activeId) {
  const next = list.filter(character => character.id !== id);
  const removed = next.length !== list.length;
  const nextActiveId = activeId === id ? resolveActiveId(next, '') : activeId;
  return { list: next, activeId: nextActiveId, removed };
}

export function withPinnedCharacter(list, id, pinned) {
  const target = list.find(character => character.id === id);
  if (!target) {
    return { list, character: null, found: false };
  }
  const updated = { ...target, pinned: pinned === true };
  const next = sortCharacters(
    list.map(character => (character.id === id ? updated : character))
  );
  return { list: next, character: updated, found: true };
}

export function withDeletedCharacters(list, ids, activeId) {
  const removal = new Set((Array.isArray(ids) ? ids : []).map(String));
  const remaining = list.filter(character => !removal.has(String(character.id)));
  const removedCount = list.length - remaining.length;
  const next = remaining.length === 0 ? [{ ...DEFAULT_CHARACTER }] : remaining;
  const nextActiveId = removal.has(String(activeId))
    ? resolveActiveId(next, '')
    : activeId;
  return { list: next, activeId: nextActiveId, removedCount };
}

// 判断默认角色是否需要补内置头像/背景：仅对默认角色生效，且仅在字段为空时。
export function describeDefaultArtwork({ id, avatarUri, bgUri, defaultId }) {
  const target = String(id === undefined || id === null ? '' : id);
  const expected = String(defaultId === undefined || defaultId === null ? '' : defaultId);
  if (!expected || target !== expected) return { avatar: false, bg: false };
  const blank = value => !String(value === undefined || value === null ? '' : value).trim();
  return { avatar: blank(avatarUri), bg: blank(bgUri) };
}

// 判断内置助手的系统提示是否该刷新为最新内置文案：只认「本机显式标记的 builtin 卡」
// 且当前系统提示仍等于某个历史种子（说明用户没改过）。用户改过的不动，非内置卡不动。
// 返回补丁对象（null 表示不改），由调用方合并落盘。
export function describeDefaultAssistantRefresh({
  id,
  builtin,
  systemPrompt,
  defaultId,
  legacyPrompts,
  nextPrompt,
}) {
  const target = String(id === undefined || id === null ? '' : id);
  const expected = String(defaultId === undefined || defaultId === null ? '' : defaultId);
  if (!expected || target !== expected) return null;
  if (builtin !== true) return null;
  const next = String(nextPrompt === undefined || nextPrompt === null ? '' : nextPrompt);
  if (!next) return null;
  const current = String(systemPrompt === undefined || systemPrompt === null ? '' : systemPrompt);
  if (current === next) return null;
  const legacy = Array.isArray(legacyPrompts) ? legacyPrompts : [];
  if (!legacy.some(item => String(item) === current)) return null;
  return { systemPrompt: next };
}

export async function runWithRollback(snapshot, restore, persist) {
  try {
    await persist();
  } catch (error) {
    restore(snapshot);
    throw error;
  }
}