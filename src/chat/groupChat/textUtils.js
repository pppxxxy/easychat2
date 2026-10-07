export function nameOf(characters, id) {
  const found = (Array.isArray(characters) ? characters : []).find(item => item.id === id);
  return found ? String(found.name || '') : '';
}

export function extractJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : raw;
  try {
    return JSON.parse(candidate);
  } catch (error) {}
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch (error) {}
  }
  return null;
}
