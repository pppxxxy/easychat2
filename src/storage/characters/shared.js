// 角色库存储领域：共享常量与纯规范化逻辑。
// 从 src/storage/characters.js 原样外提（无行为变化）。
// 模块级可变状态 characterLibraryWriteBlocked 只在本模块声明，读（isCharacterLibraryWriteBlocked）
// 与写（setCharacterLibraryWriteBlocked）都经本模块，禁止跨模块复制。

import { assignStableCharacterIds } from '../../context/characterIdentity.js';
import { normalizeCharacterPresets } from '../../character/characterPresets.js';

export const DEFAULT_CHARACTER = {
  id: 'default',
  // builtin 标记初始卡身份：改名 / 改系统提示后仍能识别，不能靠名字比对（会被用户改掉）。
  builtin: true,
  name: 'EasyChat2 助手',
  systemPrompt: '你是 EasyChat2 的智能助手，回答简洁清晰。',
  systemPromptComposed: '',
  description: '',
  personality: '',
  scenario: '',
  // 内置教学开场白：首次运行自动开启一段会话并显示，引导用户配 API、导入角色卡、开始聊天。
  // 用户可在角色编辑页改写；仅当为空时才会被内置文案补上（不覆盖用户自设）。
  firstMes: '你好，我是 EasyChat2 助手。开始很简单：\n1. 打开底部「设置」填写 API 地址与密钥；\n2. 到「角色」页导入你喜欢的角色卡；\n3. 回到这里发消息，就能开始聊天了。',
  alternateGreetings: [],
  mesExample: '',
  creatorNotes: '',
  postHistoryInstructions: '',
  tags: [],
  worldInfo: [],
  regexScripts: [],
  presets: [],
  avatarUri: '',
  bgUri: '',
  voiceDisplay: 'text',
  lastUsedAt: 0
};

export function normalizeCharacter(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const merged = { ...DEFAULT_CHARACTER, ...source };
  // 这里绝不能用 DEFAULT_CHARACTER.id 兜底：空 id 一旦变成 'default'，就会和
  // 初始卡撞成同一个身份。真正的补全交给 assignStableCharacterIds 统一分配并落盘。
  merged.id = String(source.id == null ? '' : source.id).trim();
  // builtin 只认存储里显式写过的标记，不能从 DEFAULT_CHARACTER 继承，否则所有角色都会变成初始卡。
  merged.builtin = source.builtin === true;
  const lastUsedAt = Number(merged.lastUsedAt);
  merged.lastUsedAt = Number.isFinite(lastUsedAt) ? lastUsedAt : 0;
  merged.pinned = merged.pinned === true;
  merged.tags = Array.isArray(merged.tags)
    ? merged.tags.map(tag => String(tag || '').trim()).filter(Boolean)
    : [];
  merged.alternateGreetings = Array.isArray(merged.alternateGreetings)
    ? merged.alternateGreetings.map(item => String(item == null ? '' : item))
    : [];
  merged.mesExample = String(merged.mesExample || '');
  merged.presets = normalizeCharacterPresets(merged.presets);
  // 语音形态：'text' 仅文字（默认）/ 'voice-text' 语音+原文 / 'voice' 纯语音（隐藏正文但入库）。
  merged.voiceDisplay = ['text', 'voice-text', 'voice'].includes(merged.voiceDisplay)
    ? merged.voiceDisplay
    : 'text';
  return merged;
}

export function isInitialCard(character) {
  if (character && character.builtin === true) return true;
  // 旧数据没有 builtin：退化用"名字 + 系统提示"比对，尽量在首次读取时把真初始卡认出来并补标记。
  return String(character && character.name || '') === String(DEFAULT_CHARACTER.name || '')
    && String(character && character.systemPrompt || '') === String(DEFAULT_CHARACTER.systemPrompt || '');
}

export function ensureDefaultCharacter(list, now = Date.now()) {
  const normalized = (Array.isArray(list) ? list : []).map(normalizeCharacter);
  const { list: items, changed } = assignStableCharacterIds(normalized, {
    defaultId: DEFAULT_CHARACTER.id,
    isInitial: isInitialCard,
    now,
  });
  // 补 builtin 标记：初始卡改名 / 改系统提示后仍能被识别，避免身份判定再次失效。
  // 同时只允许 default 持有 builtin：历史数据里可能残留多个 builtin，会让身份判定二义。
  let builtinChanged = false;
  const marked = items.map(item => {
    if (item.id === DEFAULT_CHARACTER.id) {
      if (item.builtin === true) return item;
      builtinChanged = true;
      return { ...item, builtin: true };
    }
    if (item.builtin === true) {
      builtinChanged = true;
      return { ...item, builtin: false };
    }
    return item;
  });
  let changedNow = changed || builtinChanged;
  if (!marked.some(item => item.id === DEFAULT_CHARACTER.id)) {
    marked.unshift(normalizeCharacter(DEFAULT_CHARACTER));
    changedNow = true;
  }
  return { list: marked, changed: changedNow };
}

// 给默认角色播种内置教学开场白（仅当尚未播种且当前为空时）。
// 存量用户的默认角色 firstMes 是空串，会覆盖 DEFAULT_CHARACTER 的新默认值，
// 故需一次性迁移；用持久化标记保证「用户主动清空后不再被填回」。
export function seedDefaultGreeting(list, seeded) {
  if (seeded) return { list, changed: false };
  let changed = false;
  const next = (Array.isArray(list) ? list : []).map(item => {
    if (item.id !== DEFAULT_CHARACTER.id) return item;
    if (String(item.firstMes || '').trim()) return item;
    changed = true;
    return { ...item, firstMes: DEFAULT_CHARACTER.firstMes };
  });
  return { list: next, changed };
}

export function sortCharacters(list) {
  return [...list].sort((a, b) => {
    const pinnedDiff = (b.pinned === true ? 1 : 0) - (a.pinned === true ? 1 : 0);
    if (pinnedDiff !== 0) return pinnedDiff;
    const diff = (b.lastUsedAt || 0) - (a.lastUsedAt || 0);
    if (diff !== 0) return diff;
    return String(a.id).localeCompare(String(b.id));
  });
}

let characterLibraryWriteBlocked = false;

export function isCharacterLibraryWriteBlocked() {
  return characterLibraryWriteBlocked;
}

// 内部 setter：供 index 在读写角色库时翻转阻断态。状态只存在于本模块。
export function setCharacterLibraryWriteBlocked(value) {
  characterLibraryWriteBlocked = value === true;
}
