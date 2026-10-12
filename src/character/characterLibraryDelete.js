// 角色库「多选删除」的纯决策层与可注入执行器（无 React、无 storage，Node 可直测）。
//
// 为什么单独抽出来：CharacterLibraryScreen.js 依赖 react-native，Node 里导入不了整屏，
// 于是这三条判定过去只有源码字符串断言可测（"行为测试为主"的要求落不了地）。
// 它们本身都是纯逻辑，抽出来后可以真正跑行为测试（见 tests/characterLibraryDelete.test.mjs）：
// - shouldDeleteEverything：确认门该不该升级成「删除全部角色」（P1-3）；
// - runCharacterDelete：执行顺序——先可重试的删角色、后不可逆的清理（P1-2）；
// - characterCleanupFailureMessageKey：按「哪几步真的做完了」选失败文案（P1-1）。

// 「可删角色 id」：默认角色永远不可删（与 context/characterLibrary.js 的
// withDeletedCharacter(s) 同口径——它们也会把 default 过滤掉）。
export function selectableCharacterIds(characters) {
  return (Array.isArray(characters) ? characters : [])
    .filter(item => item && item.id && String(item.id) !== 'default')
    .map(item => String(item.id));
}

// 删除目标 id 归一化（删除流程各入口共用同一口径：非数组当空、非字符串串化、去空）。
export function normalizeDeleteTargetIds(ids) {
  return (Array.isArray(ids) ? ids : []).map(id => String(id || '')).filter(Boolean);
}

// 这批选中项是否等于**整库的可删角色**（= 要弹「删除全部角色」的输入确认门）。
//
// 逐个比对而不是比长度（`selectedIds.length >= 全库数`）：长度比较一旦 selectedIds
// 里混进不在库中的陈旧 id（或将来出现重复 id），就会在「只删子集」的情况下误触发
// 「删除全部角色」确认门——文案承诺「会删除除默认角色外的全部角色」，实际只删一部分（P1-3）。
// 写法照同屏 allVisibleSelected 的集合口径（.every + includes），只是把集合换成整库。
export function shouldDeleteEverything(selectedIds, characters) {
  const all = selectableCharacterIds(characters);
  if (all.length === 0) return false;
  const selected = new Set((Array.isArray(selectedIds) ? selectedIds : []).map(id => String(id)));
  return all.every(id => selected.has(id));
}

// 关联清理失败的文案词条：按**实际删除结果**选，不按「打算删」选。
// 旧实现把 sessionsDeleted 无条件置 true，于是「本来就没有关联记忆」也被报成
// 「关联动态和记忆已删除」（P1-1）。
// 写成 xxxKey 形态是为了让 scripts/find_missing_i18n_keys.js 的间接引用扫描看得见。
const CLEANUP_FAILURE_KEYS = {
  momentsKey: 'character.library.delete.fail.cleanupMoments',
  sessionsKey: 'character.library.delete.fail.cleanupSessions',
  bothKey: 'character.library.delete.fail.cleanupBoth',
};

// 返回失败文案的词条 key；null = 关联清理全部成功（调用方不弹提示）。
export function characterCleanupFailureMessageKey({ momentsDeleted, sessionsDeleted, hasSessions }) {
  const momentsPending = momentsDeleted !== true;
  const sessionsPending = hasSessions === true && sessionsDeleted !== true;
  if (!momentsPending && !sessionsPending) return null;
  if (momentsPending && sessionsPending) return CLEANUP_FAILURE_KEYS.bothKey;
  return momentsPending ? CLEANUP_FAILURE_KEYS.momentsKey : CLEANUP_FAILURE_KEYS.sessionsKey;
}

// 执行删除。顺序即纪律（P1-2）：
// 1. **先删角色**——它可重试，失败时盘上什么都没有被破坏；
//    而且删角色本身会通过 onCharacterDeleted 钩子连带清理动态/专属配置/日程/日记等
//    （storage/characterState.js:59-60 无条件跑钩子，钩子各自容错）。
// 2. 角色删成功后才做**不可逆**的关联清理：动态 → 会话（记忆）。
//
// 为什么不能反过来（旧实现）：先删动态与会话、再删角色，一旦角色删除失败，记忆与动态
// 已经永久没了而角色还在——跨域无回滚，用户重试也救不回来。
//
// 取舍（为什么接受「角色删了、清理失败」这个中间态）：那一步的失败是**可见且可重试**的
// ——会话还在记忆页、动态还在动态页，用户手动删一次即可；而旧顺序的失败是**不可逆的
// 数据丢失**。两害相权取其轻，且失败文案会明确告诉用户去哪手动清理。
// 注意这里**不会**产生新的孤儿数据问题：会话本来就不随角色删除级联
// （characterLifecycle 的钩子只清各域自己的键，不含会话表），
// 所以「角色已删、会话暂留」与「用户只删角色不删记忆」是同一个既有状态，
// 记忆页照常列出、照常可删。
//
// 另一个必须写清的事实（决定了本顺序的收益边界）：动态其实**已经**由角色删除本身带走
// —— storage/moments.js:285 注册的 onCharacterDeleted 钩子在每次删角色时按 characterId
// 清动态（与用户选没选「连动态一起删」无关，这是既有的、与「仅删角色」文案不一致的行为，
// 见报告里「需要别的文件配合的清单」）。因此：
// - 调整顺序**不可能**让动态变得更危险（它本来就随角色删除走）；
// - 真正的不可逆风险在**会话（记忆）**：它不被任何钩子清，旧顺序下「先删会话、后删角色」
//   一旦角色删除失败，记忆就永久没了 —— 这正是本次顺序调整要修的洞；
// - 这里的 removeMomentsStep 是**幂等重试**（钩子是 best-effort、失败只留诊断），
//   让「用户明确选了『连动态一起删』」这件事有可观测的失败，而不是被钩子静默吞掉。
//
// 角色删除失败时**直接抛出**（不做任何清理，fail-closed）；清理失败只记录在返回值里
// （不中断后续步骤，因为角色已经删了，用户需要知道「哪些关联数据没清掉」而不是整件事重来）。
export async function runCharacterDelete({
  deleteCharactersStep,
  deleteMemories = false,
  memoryIds = [],
  removeMomentsStep,
  deleteSessionsStep,
}) {
  const result = {
    characterDeleted: false,
    momentsDeleted: false,
    sessionsDeleted: false,
    momentsError: null,
    sessionsError: null,
  };
  await deleteCharactersStep();
  result.characterDeleted = true;
  if (!deleteMemories) return result;
  const sessions = (Array.isArray(memoryIds) ? memoryIds : []).filter(Boolean);
  try {
    await removeMomentsStep();
    result.momentsDeleted = true;
  } catch (error) {
    result.momentsError = error;
  }
  // 本来就没有关联记忆：不调用删除，也不谎报「已删除」（P1-1）。
  if (sessions.length === 0) return result;
  try {
    await deleteSessionsStep();
    result.sessionsDeleted = true;
  } catch (error) {
    result.sessionsError = error;
  }
  return result;
}
