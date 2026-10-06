// JSON 文本清洗与解析（容错全角/围栏/裸换行）。纯函数。
import { tActive } from '../../i18n/index.js';

import { normalizeCard } from './normalizeCard.js';

function normalizeJsonText(text) {
  let source = String(text || '').replace(/^\uFEFF/, '').trim();
  const fenced = source.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) source = fenced[1];
  let output = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) {
        output += char;
        escaped = false;
      } else if (char === '\\') {
        output += char;
        escaped = true;
      } else if (char === '"') {
        output += char;
        inString = false;
      } else if (char === '\r') {
        output += '\\n';
        if (source[index + 1] === '\n') index += 1;
      } else if (char === '\n') {
        output += '\\n';
      } else if (char === '\t' || char === '\b' || char === '\f') {
        output += `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
      } else {
        output += char;
      }
      continue;
    }
    if (char === '"') {
      output += char;
      inString = true;
    } else if (char === '\u3000' || char === '\u00a0' || char === '\u2028' || char === '\u2029') {
      output += ' ';
    } else if (char === '\uFF1A') {
      output += ':';
    } else if (char === '\uFF0C') {
      output += ',';
    } else {
      output += char;
    }
  }
  return output;
}

export function parseCardFromJson(text) {
  let raw;
  try {
    raw = JSON.parse(normalizeJsonText(text));
  } catch (error) {
    throw new Error(tActive('error.cardParser.jsonSyntax', { message: error.message }));
  }
  return normalizeCard(raw);
}

export { normalizeJsonText };
