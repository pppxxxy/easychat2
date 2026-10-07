import { getMessagePromptText } from '../chatMedia.js';
import { applyRegexScripts, REGEX_PLACEMENT } from '../../prompt/regexEngine.js';
import { nameOf } from './textUtils.js';

export function speakerLabel(characters, item) {
  if (item?.role === 'user') return '用户';
  const name = String(item?.speakerName || nameOf(characters, item?.speakerId) || '').trim();
  return name || '角色';
}

export function buildGroupMediaPrompt(item, characters) {
  const scripts = (Array.isArray(characters) ? characters : [])
    .flatMap(character => Array.isArray(character && character.regexScripts)
      ? character.regexScripts
      : []);
  return applyRegexScripts(
    getMessagePromptText(item),
    scripts,
    REGEX_PLACEMENT.USER_INPUT,
    { mode: 'prompt', depth: 0 }
  );
}
