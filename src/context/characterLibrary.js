import { DEFAULT_CHARACTER, sortCharacters } from '../storage/characters.js';
import { recordDiagnostic } from '../storage/diagnostics.js';
import { tActive } from '../i18n/index.js';

export function resolveActiveId(list, activeId) {
  if (activeId && list.some(character => character.id === activeId)) {
    return activeId;
  }
  const fallback = list.find(character => character.id === DEFAULT_CHARACTER.id);
  return fallback ? fallback.id : DEFAULT_CHARACTER.id;
}

export function uniqueId(base, list) {
  let id = String(base || '').trim() || `card-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  if (!list.some(character => character.id === id)) return id;
  let suffix = 2;
  while (list.some(character => character.id === `${id}-${suffix}`)) {
    suffix += 1;
  }
  return `${id}-${suffix}`;
}

export function withUpdatedCharacter(list, activeId, patch) {
  const active = list.find(character => character.id === activeId) || DEFAULT_CHARACTER;
  const resolvedPatch = typeof patch === 'function' ? patch(active) : patch;
  const merged = { ...active, ...(resolvedPatch || {}), id: active.id };
  const next = sortCharacters(
    list.map(character => (character.id === merged.id ? merged : character))
  );
  return { list: next, character: merged };
}

export function withSwitchedCharacter(list, id, now) {
  const target = list.find(character => character.id === id);
  if (!target) {
    return { list, character: null, found: false };
  }
  const touched = { ...target, lastUsedAt: now };
  const next = sortCharacters(
    list.map(character => (character.id === id ? touched : character))
  );
  return { list: next, character: touched, found: true };
}

// 新建角色时**必须**显式清掉的身份/文案字段。照 character/cardHelpers.js 的既有口径
// （`:112 firstMes: fields.firstMes || ''`、`:145 firstMes: String(source.firstMes || '')`）
// 归一到空串，而不是 undefined：全仓读这些字段的地方都按「字符串」处理，空串是唯一
// 被统一认可的「没有」。
//
// 为什么要清（而不是让 DEFAULT_CHARACTER 的值漏过去）：withAddedCharacter 用
// `{ ...DEFAULT_CHARACTER, ...character }` 打底，DEFAULT_CHARACTER 是**内置助手卡**，
// 它的 firstMes 是教学开场白（「你好，我是 EasyChat2 助手。开始很简单：…」）、
// systemPrompt 是「你是 EasyChat2 的智能助手，回答简洁清晰。」。角色页「新建」只传
// { name }（CharacterLibraryScreen.js:408），于是新角色的开场白变成助手的自我介绍、
// 系统提示变成助手的人设——用户以为自己建了张白纸，实际拿到的是内置助手的副本。
// 另 3 个 addCharacter 调用点（cardForge/forge/draft.js:93、CharacterDetailScreen.js:719）
// 都显式给了 firstMes ⇒「firstMes 总由调用方提供」是本仓既有约定，CharacterLibraryScreen
// 那处是唯一例外；清空让这个例外也回到「缺省即空」的一致语义。
//
// 为什么只清这两个字符串字段（逐个判断，不是照抄）：
//   清 firstMes            → 开场白是**角色身份的一部分**，继承助手文案会让新角色一上来
//                            就用别人的自我介绍开口；症状最直接。
//   清 systemPrompt        → 人设提示同理，且它会改变模型对这张卡的全部回答基调。
//   留 name/description/personality/scenario/mesExample/creatorNotes/postHistoryInstructions
//                          → 这些在 DEFAULT_CHARACTER 里本来就是空串，继承等于空，无害；
//                            但**不能**用「一起清掉」代替判断：调用方显式传值时它们必须留下。
//   留 avatarUri / bgUri   → DEFAULT_CHARACTER 里也是空串（内置占位图由启动时的
//                            materializeDefaultArtwork 单独落到 default 卡上，不走这里），
//                            所以「新角色会继承助手的头像」在数据上不成立；调用方显式传的
//                            头像/背景仍照常保留。
//   留 voiceDisplay/pinned 等开关 → DEFAULT_CHARACTER 给的是默认枚举/默认布尔。
//   清 builtin             → 新增角色永远不是初始卡（见下）。
// 容器类字段（alternateGreetings 与 tags/worldInfo/regexScripts/presets）走
// EMPTY_ARRAY_ON_ADD：**不是**「继承即空」那么简单——DEFAULT_CHARACTER 是模块级单例，
// 直接继承会把它的数组引用交给新角色（新角色改 tags 会改到内置卡）。所以统一改成
// 「只认调用方自己的值，否则给一个新空数组」，既清掉助手的备用问候，也切断共享引用。
const BLANK_ON_ADD = ['firstMes', 'systemPrompt'];
const EMPTY_ARRAY_ON_ADD = ['alternateGreetings', 'tags', 'worldInfo', 'regexScripts', 'presets'];

export function withAddedCharacter(list, character, now) {
  const source = character && typeof character === 'object' ? character : {};
  const next = {
    ...DEFAULT_CHARACTER,
    ...source,
    id: uniqueId(source.id, list),
    // 新增角色永远不是初始卡；显式清掉从 DEFAULT_CHARACTER 继承来的 builtin 标记。
    builtin: false,
    lastUsedAt: now,
  };
  for (const field of BLANK_ON_ADD) {
    next[field] = String(source[field] || '');
  }
  for (const field of EMPTY_ARRAY_ON_ADD) {
    next[field] = Array.isArray(source[field]) ? source[field] : [];
  }
  return { list: sortCharacters([...list, next]), character: next };
}

export function withDeletedCharacter(list, id, activeId) {
  const next = list.filter(character => character.id !== id);
  const removed = next.length !== list.length;
  const nextActiveId = activeId === id ? resolveActiveId(next, '') : activeId;
  return { list: next, activeId: nextActiveId, removed };
}

export function withPinnedCharacter(list, id, pinned) {
  const target = list.find(character => character.id === id);
  if (!target) {
    return { list, character: null, found: false };
  }
  const updated = { ...target, pinned: pinned === true };
  const next = sortCharacters(
    list.map(character => (character.id === id ? updated : character))
  );
  return { list: next, character: updated, found: true };
}

export function withDeletedCharacters(list, ids, activeId) {
  const removal = new Set((Array.isArray(ids) ? ids : []).map(String));
  const remaining = list.filter(character => !removal.has(String(character.id)));
  const removedCount = list.length - remaining.length;
  const next = remaining.length === 0 ? [{ ...DEFAULT_CHARACTER }] : remaining;
  const nextActiveId = removal.has(String(activeId))
    ? resolveActiveId(next, '')
    : activeId;
  return { list: next, activeId: nextActiveId, removedCount };
}

// 判断默认角色是否需要补内置头像/背景：仅对默认角色生效，且仅在字段为空时。
export function describeDefaultArtwork({ id, avatarUri, bgUri, defaultId }) {
  const target = String(id === undefined || id === null ? '' : id);
  const expected = String(defaultId === undefined || defaultId === null ? '' : defaultId);
  if (!expected || target !== expected) return { avatar: false, bg: false };
  const blank = value => !String(value === undefined || value === null ? '' : value).trim();
  return { avatar: blank(avatarUri), bg: blank(bgUri) };
}

export async function runWithRollback(snapshot, restore, persist) {
  try {
    await persist();
  } catch (error) {
    restore(snapshot);
    throw error;
  }
}

// ---- 启动加载失败的处置（AppContext 启动 effect 的 catch 复用本函数）----
//
// 背景（已逐行核实的不可逆链）：AppContext 启动时 Promise.all 读角色库/会话列表，
// 任一 reject 就落进 catch；此前那个 catch 把 error **一次都没引用**（不记诊断、不设
// 错误态、不弹提示），却把内存写成「1 个角色 + 0 会话」，finally 照样 loaded=true。
// 于是用户点一次编辑/置顶/新增，saveCharacterLibrary 就用盘上索引算 stale，把其余
// N-1 个逐角色键与大卡正文文件删掉——不可逆。仓库其实早有这道防线
// （storage/characters/index.js 在「读不全」时置位写闸，saveCharacterLibrary 据此
// 拒绝写），只是 catch 分支从来没用过它。
//
// 所以这里只做三件事，且顺序固定：
//   1. 合闸（fail-closed）。**任何**启动读取失败都合闸，不区分是角色库还是会话列表
//      抛的：调用方在 reject 之后拿到的是一份残缺内存快照，它**不足以**作为写回的
//      依据；「这份快照是好的」这件事本身就没被证明。宁可多挡一次写（用户看到
//      「角色库仍在恢复中」，重试即可），也不能赌一次不可逆删除。
//   2. 留痕。启动加载失败此前在诊断里查无此事，用户与开发者都无从判断数据是没了
//      还是没读出来。
//   3. 给出可见文案。全仓其它「读失败」路径至少有一条用户可见提示
//      （chat.session.loadFailed.*、books.load.failed、music.load.failed、
//      memory.moments.readFail），唯独 App 启动加载没有。文案用现成词条
//      error.storage.characterIndexReadFailed（中英双语早已写好、此前零消费），
//      body 带上真实 error.message 以便用户/开发者定位是哪一个键读不出。
export function resolveStartupFailure(error, blockWrites) {
  if (typeof blockWrites === 'function') blockWrites(true);
  // message 自足，理由同 storage/characters/index.js 的 getCharacterLibrary：maskSecrets
  // 可能把 error.message 整段清空（「疑似密钥」），那样这条诊断会与同窗口的其它诊断
  // 同签名而被去重丢掉。真实 error.message 放进 context（它同样会过 mask，但不参与去重）。
  recordDiagnostic(
    'startup',
    new Error('启动加载失败，已合上角色库写闸（阻止用残缺列表写回）'),
    `AppContext 启动加载：${String((error && error.message) || error || '')}`
  );
  const detail = String((error && error.message) || '').trim();
  return {
    title: tActive('error.storage.characterIndexReadFailed'),
    body: detail,
    // 供调用方写进上下文值/日志的原因串；空串表示没有更具体的信息。
    reason: detail,
  };
}
