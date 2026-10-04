const cache = new WeakMap();

export function getCachedDisplayText(message, scripts, placement, depth, compute) {
  if (!message || typeof compute !== 'function') return compute ? compute() : '';
  let entries = cache.get(message);
  if (!entries) {
    entries = new Map();
    cache.set(message, entries);
  }
  const key = `${placement}\u0000${depth}`;
  const cached = entries.get(key);
  if (cached && cached.scripts === scripts) return cached.result;
  const result = compute();
  entries.set(key, { scripts, result });
  return result;
}
