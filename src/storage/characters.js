// 角色库存储领域 barrel。从 src/storage.js 原样外提（无行为变化）。
// 实现已拆到 src/storage/characters/ 子目录：shared（共享常量与纯函数）、
// payload（大角色正文文件负载）、index（索引/迁移/活动角色/编辑草稿聚合）。
// 注：saveCharacterState（删除/保存的跨领域编排）在 storage/characterState.js
// （2026-10-07 快赢1 自门面迁出），孤儿媒体回收在 storage/orphanMedia.js。

export {
  CHARACTER_ITEM_PREFIX,
  DEFAULT_CHARACTER,
  sortCharacters,
  isCharacterLibraryWriteBlocked,
  hasShownDefaultGreeting,
  markDefaultGreetingShown,
  getCharacterLibrary,
  saveCharacterLibrary,
  getActiveCharacterId,
  setActiveCharacterId,
  saveCharacterEditDraft,
  takeCharacterEditDraft,
  clearCharacterEditDraft,
} from './characters/index.js';
