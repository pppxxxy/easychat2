import { isCanceledError, isConfigChangedError, sendChatMessage } from '../../network/api.js';
import { extractJson } from './textUtils.js';

export async function generateOpening({ characters, userProfile, globalPresets, expectedConfigId = '', expectedConfigFingerprint = '', signal = null }) {
  const list = Array.isArray(characters) ? characters : [];
  if (list.length === 0) return null;
  const roster = list
    .map(character => `- ${character.name}: ${String(character.description || character.personality || '').slice(0, 100)}`)
    .join('\n');
  const rosterLines = [`成员：\n${roster}`];
  const openingPersona = String((userProfile && userProfile.persona) || '').trim();
  if (openingPersona) rosterLines.push(`[用户设定]\n${openingPersona}`);
  const openingPresets = (Array.isArray(globalPresets) ? globalPresets : [])
    .map(item => String(item || '').trim())
    .filter(Boolean)
    .join('\n');
  if (openingPresets) rosterLines.push(`[全局预设]\n${openingPresets}`);
  const prompt = [
    {
      role: 'system',
      content: '你是群聊导演。根据成员设定写一段简短的群聊开场，交代场景与在场角色（2-3 句）。'
        + '只输出 JSON，格式为 {"opening": "开场白", "speaker": "首先发言的角色名"}，不要解释。',
    },
    { role: 'user', content: rosterLines.join('\n\n') },
  ];
  let parsed = null;
  try {
     const text = await sendChatMessage(prompt, {
       expectedConfigId,
       expectedConfigFingerprint,
       signal,
     });
    parsed = extractJson(text);
  } catch (error) {
    if (isConfigChangedError(error) || isCanceledError(error)) throw error;
    parsed = null;
  }
  if (!parsed) {
    const first = list[0];
    return {
      opening: `${list.map(character => character.name).join('、')} 已经就位，对话开始了。`,
      speakerId: first.id,
      speakerName: String(first.name || ''),
    };
  }
  const speakerName = String(parsed.speaker || '').trim();
  const speaker = list.find(character =>
    String(character.name || '').trim() === speakerName
  ) || list[0];
  return {
    opening: String(parsed.opening || '').trim()
      || `${list.map(character => character.name).join('、')} 已经就位。`,
    speakerId: speaker.id,
    speakerName: String(speaker.name || ''),
  };
}
