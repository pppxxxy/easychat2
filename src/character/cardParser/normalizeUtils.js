// 角色卡归一化通用小工具：对象/字符串/布尔/数字的容错取值。纯函数。

export function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function firstString(sources, keys) {
  for (const source of sources) {
    if (!isPlainObject(source)) continue;
    for (const key of keys) {
      const value = source[key];
      if (value === null || value === undefined) continue;
      const text = String(value).trim();
      if (text) return text;
    }
  }
  return '';
}

export function toStringList(value) {
  if (Array.isArray(value)) return toStringArray(value);
  if (typeof value === 'string') {
    const text = value.trim();
    return text ? [text] : [];
  }
  return [];
}

export function toStringArray(value) {
  if (Array.isArray(value)) {
    return value.map(item => String(item ?? '').trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(/[,，\n]/)
      .map(item => item.trim())
      .filter(Boolean);
  }
  return [];
}

export function toBool(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(lowered)) return true;
    if (['false', '0', 'no', 'off'].includes(lowered)) return false;
  }
  return fallback;
}

export function firstNumber(sources, keys, fallback) {
  for (const source of sources) {
    if (!isPlainObject(source)) continue;
    for (const key of keys) {
      const raw = source[key];
      if (raw === null || raw === undefined || raw === '') continue;
      const value = Number(raw);
      if (Number.isFinite(value)) return value;
    }
  }
  return fallback;
}

export function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}
