import { isCanceledError, isConfigChangedError, sendChatMessage } from '../../network/api.js';
import { PROFILE_MIN_CHARS } from './constants.js';

export function staticProfileOf(character) {
  const description = String(character?.description || '').trim();
  const personality = String(character?.personality || '').trim();
  return [description, personality].filter(Boolean).join(' ').trim();
}

export function needsProfile(character) {
  return staticProfileOf(character).length < PROFILE_MIN_CHARS;
}

function buildProfilePrompt(character) {
  const fields = [
    ['名称', character?.name],
    ['简介', character?.description],
    ['性格', character?.personality],
    ['场景', character?.scenario],
    ['对话示例', character?.mesExample],
    ['开场白', Array.isArray(character?.alternateGreetings)
      ? character.alternateGreetings.join(' / ')
      : ''],
  ]
    .map(([label, value]) => {
      const text = String(value || '').trim();
      return text ? `${label}：${text}` : '';
    })
    .filter(Boolean)
    .join('\n');
  return [
    {
      role: 'system',
      content: '你根据角色卡信息，用一到两句第三人称中文简介概括这个角色的人设，'
        + '供群聊中其他角色了解它。只输出简介正文，不要引号、不要解释、不要分段。',
    },
    { role: 'user', content: fields || `名称：${String(character?.name || '角色')}` },
  ];
}

export async function generateMemberProfile(character, expectedConfigId = '', expectedConfigFingerprint = '', signal = null) {
  if (!character) return null;
  try {
    const text = await sendChatMessage(buildProfilePrompt(character), {
      expectedConfigId,
      expectedConfigFingerprint,
      signal,
    });
    const profile = String(text || '').replace(/\s+/g, ' ').trim();
    return profile || null;
  } catch (error) {
    if (isConfigChangedError(error) || isCanceledError(error)) throw error;
    return null;
  }
}

export async function ensureMemberProfiles({ characters, profiles, expectedConfigId = '', expectedConfigFingerprint = '', signal = null }) {
  const list = Array.isArray(characters) ? characters : [];
  const current = profiles && typeof profiles === 'object' ? profiles : {};
  const next = { ...current };
  for (const character of list) {
    if (signal && signal.aborted) {
      const error = new Error('已停止生成。');
      error.name = 'AbortError';
      error.canceled = true;
      throw error;
    }
    if (!character || !character.id) continue;
    if (next[character.id]) continue;
    if (!needsProfile(character)) continue;
    const profile = await generateMemberProfile(
      character,
      expectedConfigId,
      expectedConfigFingerprint,
      signal
    );
    if (profile) next[character.id] = profile;
  }
  return next;
}
