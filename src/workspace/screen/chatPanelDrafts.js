// FEAT-AC11：工作区对话的**输入草稿缓存**（从 ChatPanel 外提）。
//
// 为什么要有内存缓存（而不是只读盘）：草稿落盘是异步的，而重新挂载发生在
// **卸载之后**——若直接读盘，可能读到落盘前的旧值。内存缓存同步生效，负责
// 「切回来立刻有」，盘上的 chat.draft 负责跨重启。
//
// ⚠️ FEAT-AC11 P0-1 更新了「何时会卸载」这个前提：
// 该注释原写「切面板会卸载整个聊天组件（WorkspaceScreen 条件渲染）」——**已不成立**：
// 窄屏现在也常驻（切 tab 只 display:'none'，组件保持挂载），所以卸载只剩
// 「整个工作区 Modal 被销毁」这一条路径。缓存本身仍然必要（关掉工作区再打开
// 就是一次真实的卸载+重挂载），但注释必须说实话，否则后人会以为切 tab 仍需靠它兜底。
//
// 为什么外提成独立模块：这三个函数**本来就是模块级纯函数**（只碰模块级的 draftCache
// 与存储入口），此前裹在 ChatPanel 里用 useCallback 包了一层——而它们没有任何
// 依赖需要 memo（deps 全空），那层包装是多余的。外提同时把 ChatPanel 的行数
// 降回棘轮基线之下（纪律：拆文件，不抬上限）。

import { saveWorkspaceChatDraft } from '../../storage/workspace.js';

// 键 `${characterId}:${chatId}`。
const draftCache = new Map();

function draftCacheKey(ownerId, chatId) {
  return `${String(ownerId || '')}:${String(chatId || '')}`;
}

/** 打字时只写内存（零 IO、不卡输入）。 */
export function rememberDraft(ownerId, chatId, text) {
  const id = String(chatId || '');
  if (!id) return;
  draftCache.set(draftCacheKey(ownerId, id), String(text === undefined || text === null ? '' : text));
}

/** 写内存 + 落盘。落盘失败静默：草稿不值得打断用户（内存缓存还在，切回来照常有）。 */
export function persistDraft(ownerId, chatId, text) {
  const id = String(chatId || '');
  if (!id) return;
  const value = String(text === undefined || text === null ? '' : text);
  draftCache.set(draftCacheKey(ownerId, id), value);
  saveWorkspaceChatDraft(ownerId, id, value).catch(() => {});
}

/** 读草稿：内存优先（同进程内即时、无 IO 竞态），其次盘上的 chat.draft（跨重启）。 */
export function readDraft(ownerId, chatId, fallback) {
  const id = String(chatId || '');
  if (!id) return '';
  const cached = draftCache.get(draftCacheKey(ownerId, id));
  if (cached !== undefined) return cached;
  return String(fallback === undefined || fallback === null ? '' : fallback);
}

/** 测试可见：清空缓存（模块级状态在用例之间必须隔离）。 */
export function __resetDraftCache() {
  draftCache.clear();
}
