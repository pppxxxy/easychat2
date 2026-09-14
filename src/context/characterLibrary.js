import { DEFAULT_CHARACTER, sortCharacters } from '../storage';

export function resolveActiveId(list, activeId) {
  if (activeId && list.some(character => character.id === activeId)) {
    return activeId;
  }
  const fallback = list.find(character => character.id === DEFAULT_CHARACTER.id);
  return fallback ? fallback.id : DEFAULT_CHARACTER.id;
}

export function uniqueId(base, list) {
  let id = String(base || '').trim() || `card-${Date.now().toString(36)}`;
  if (!list.some(character => character.id === id)) return id;
  let suffix = 2;
  while (list.some(character => character.id === `${id}-${suffix}`)) {
    suffix += 1;
  }
  return `${id}-${suffix}`;
}

export function withUpdatedCharacter(list, activeId, patch) {
  const active = list.find(character => character.id === activeId) || DEFAULT_CHARACTER;
  const merged = { ...active, ...patch, id: active.id };
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

export async function runWithRollback(snapshot, restore, persist) {
  try {
    await persist();
  } catch (error) {
    restore(snapshot);
    throw error;
  }
}