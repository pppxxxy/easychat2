const DEFAULT_SCAN_DEPTH = 4;

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function keywordMatches(keyword, haystack, entry) {
  if (!keyword || !haystack) return false;
  const caseSensitive = entry.caseSensitive === true;
  if (entry.useRegex) {
    try {
      const flags = caseSensitive ? '' : 'i';
      const source = entry.matchWholeWords ? `\\b(?:${keyword})\\b` : keyword;
      return new RegExp(source, flags).test(haystack);
    } catch (error) {
      return false;
    }
  }
  if (entry.matchWholeWords) {
    try {
      const re = new RegExp(
        `\\b${escapeRegExp(keyword)}\\b`,
        caseSensitive ? '' : 'i'
      );
      return re.test(haystack);
    } catch (error) {
      return false;
    }
  }
  const source = caseSensitive ? haystack : haystack.toLowerCase();
  const needle = caseSensitive ? keyword : keyword.toLowerCase();
  return source.includes(needle);
}

function matchesAnyKeyword(keys, haystack, entry) {
  return keys.some(key => keywordMatches(key, haystack, entry));
}

function buildScanText(entry, messageTexts) {
  const depth = Number.isFinite(entry.scanDepth)
    ? Math.max(1, entry.scanDepth)
    : DEFAULT_SCAN_DEPTH;
  return messageTexts.slice(-depth).join('\n');
}

function rollProbability(entry) {
  if (entry.useProbability === false) return true;
  const probability = Number(entry.probability);
  if (!Number.isFinite(probability) || probability >= 100) return true;
  if (probability <= 0) return false;
  return Math.random() * 100 < probability;
}

export function isEntryActive(entry, messageTexts) {
  if (!entry || entry.enabled === false) return false;
  if (entry.constant) return rollProbability(entry);
  const keys = Array.isArray(entry.keys) ? entry.keys : [];
  if (keys.length === 0) return false;
  const haystack = buildScanText(entry, messageTexts);
  if (!matchesAnyKeyword(keys, haystack, entry)) return false;
  if (entry.selective && Array.isArray(entry.secondaryKeys) && entry.secondaryKeys.length > 0) {
    if (!matchesAnyKeyword(entry.secondaryKeys, haystack, entry)) return false;
  }
  return rollProbability(entry);
}

export function collectActiveWorldInfo(character, historyMessages, latestUserText) {
  const entries = Array.isArray(character?.worldInfo) ? character.worldInfo : [];
  if (entries.length === 0) {
    return { before: [], after: [], depth: [] };
  }
  const messageTexts = (Array.isArray(historyMessages) ? historyMessages : [])
    .filter(item => item && (item.role === 'user' || item.role === 'assistant'))
    .map(item => String(item.text || ''));
  messageTexts.push(String(latestUserText || ''));

  const active = entries.filter(entry => isEntryActive(entry, messageTexts));
  const byOrder = (a, b) => (a.order ?? 100) - (b.order ?? 100);

  return {
    before: active.filter(entry => entry.position === 0).sort(byOrder),
    after: active.filter(entry => entry.position !== 0 && entry.position !== 4).sort(byOrder),
    depth: active.filter(entry => entry.position === 4).sort(byOrder),
  };
}

export function buildWorldInfoText(entries) {
  return (Array.isArray(entries) ? entries : [])
    .map(entry => String(entry?.content || '').trim())
    .filter(Boolean)
    .join('\n\n');
}
