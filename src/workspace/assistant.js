// 工作区默认助手：候选是一张真实的角色卡（EasyChat2 工作助手 / 你是一个有用的助手）。
//
// 早期行为是「库里没有就自动建卡」，于是用户删掉这张卡后一打开工作区它就复活，
// 看起来像删不掉（而真正不可删的只有内置助手）。现在解析不到**不再建卡**，
// 改为回落到内置助手（builtin 标记，永远存在且不可删除），再退回库中第一个角色：
// 面板始终有角色可用，用户也能真正删掉那张卡。
//
// 本模块**零静态依赖**：存储层惰性 require——纯函数部分（常量、pick、resolve）
// 必须能被 Node 直接 import 做单测，而 storage 会拉进 expo-file-system 等原生模块。

export const WORKSPACE_ASSISTANT_NAME = 'EasyChat2 工作助手';
export const WORKSPACE_ASSISTANT_PROMPT = '你是一个有用的助手';

// 从角色库挑默认工作助手（纯函数）：先「名字+提示词」双匹配（提示词未被改过的
// 原卡），再退名字匹配（用户改过提示词仍是同一张卡）。找不到返回 null。
export function pickWorkspaceAssistant(list) {
  const characters = Array.isArray(list) ? list : [];
  return characters.find(item => item && item.name === WORKSPACE_ASSISTANT_NAME
    && String(item.systemPrompt || '').trim() === WORKSPACE_ASSISTANT_PROMPT)
    || characters.find(item => item && item.name === WORKSPACE_ASSISTANT_NAME)
    || null;
}

// 兜底角色（纯函数）：内置助手优先（builtin 标记，不可删除、必然存在），
// 否则退回库中第一个；库为空时返回 null，由面板兜底不阻断打开。
export function pickFallbackCharacter(list) {
  const characters = Array.isArray(list) ? list : [];
  return characters.find(item => item && item.builtin === true)
    || characters[0]
    || null;
}

// 在角色库里解析目标工作区角色（纯函数，便于单测）：
// - 设置里有 id 且命中 → 用它；
// - 否则挑默认工作助手（用户已有的那张卡继续生效）；
// - 都没有 → 回落到内置助手/库中第一个（不再建卡，删掉的卡不会复活）。
export function resolveWorkspaceCharacter(characterId, list) {
  const wanted = String(characterId || '').trim();
  const characters = Array.isArray(list) ? list : [];
  if (wanted) {
    const existing = characters.find(item => item && item.id === wanted);
    if (existing) return { character: existing, needsEnsure: false };
  }
  const assistant = pickWorkspaceAssistant(characters);
  if (assistant) return { character: assistant, needsEnsure: false };
  const fallback = pickFallbackCharacter(characters);
  return { character: fallback, needsEnsure: false };
}

// IO 外壳：按设置解析工作区角色。
// 返回 { character, id, persist, created }：persist = 需要把选中的角色写回设置；
// created 恒为 false（保留字段以兼容既有调用方）；character 为 null 仅当角色库不可用。
export async function resolveWorkspaceAssistant(characterId = '') {
  const wanted = String(characterId || '').trim();
  try {
    const { getCharacterLibrary } = require('../storage.js');
    const list = await getCharacterLibrary();
    const picked = resolveWorkspaceCharacter(wanted, list);
    if (picked.character) {
      const id = String(picked.character.id || '');
      return { character: picked.character, id, persist: id !== wanted, created: false };
    }
  } catch (error) {}
  // 兜底：角色库不可用时不阻断面板（沿用传入的默认 id，界面会显示 id）。
  return { character: null, id: wanted, persist: false, created: false };
}
