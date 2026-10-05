// 工作区默认助手：一张真实的角色卡（EasyChat2 工作助手 / 你是一个有用的助手）。
//
// 建卡刻意不走 AppContext.addCharacter()：那个入口会把「当前激活角色」切到新卡，
// 而「打开工作区」不该顺带切走用户正在聊的角色。这里用纯函数 withAddedCharacter +
// saveCharacterLibrary 直接落库，由面板调用 refreshAppData() 同步内存列表。
//
// 本模块**零静态依赖**：存储层/角色库都在函数内惰性 require——纯函数部分
//（常量、pick、resolve）必须能被 Node 直接 import 做单测，而 storage 会拉进
// expo-file-system 等原生模块。

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

// 在角色库里解析目标工作区角色（纯函数，便于单测）：
// - 设置里有 id 且命中 → 用它；
// - 否则挑默认工作助手（needsEnsure = 库里没有，需要建卡）。
export function resolveWorkspaceCharacter(characterId, list) {
  const wanted = String(characterId || '').trim();
  const characters = Array.isArray(list) ? list : [];
  if (wanted) {
    const existing = characters.find(item => item && item.id === wanted);
    if (existing) return { character: existing, needsEnsure: false };
  }
  const assistant = pickWorkspaceAssistant(characters);
  if (assistant) return { character: assistant, needsEnsure: false };
  return { character: null, needsEnsure: true };
}

// 确保默认工作助手存在（复用或新建）。库读写出错时返回 { character: null,
// created: false }，由面板兜底（不阻断打开工作区）。
export async function ensureWorkspaceAssistant() {
  try {
    const { getCharacterLibrary, saveCharacterLibrary } = require('../storage.js');
    const { withAddedCharacter } = require('../context/characterLibrary.js');
    const list = await getCharacterLibrary();
    const existing = pickWorkspaceAssistant(list);
    if (existing) return { character: existing, created: false };
    const { list: nextList, character } = withAddedCharacter(list, {
      name: WORKSPACE_ASSISTANT_NAME,
      systemPrompt: WORKSPACE_ASSISTANT_PROMPT,
    }, Date.now());
    await saveCharacterLibrary(nextList);
    return { character, created: true };
  } catch (error) {
    return { character: null, created: false };
  }
}

// IO 外壳：按设置解析工作区角色；库里没有默认助手时自动建卡。
// 返回 { character, id, persist, created }：persist = 需要把选中的角色写回设置；
// created = 新建了角色卡（面板需 refreshAppData 同步内存列表）。
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
    const { character, created } = await ensureWorkspaceAssistant();
    if (character) {
      return { character, id: String(character.id || ''), persist: true, created };
    }
  } catch (error) {}
  // 兜底：角色库不可用时不阻断面板（沿用传入的默认 id，界面会显示 id）。
  return { character: null, id: wanted, persist: false, created: false };
}