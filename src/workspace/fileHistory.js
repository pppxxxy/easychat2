// J1：文件层写前快照（file-history）——外部调研"checkpoint"内核的本地轻量实现。
//
// 语义：**写系工具落笔前**把旧内容存一份（含"新建"——oldContent 为空也记录，
// 使删除可逆）；「恢复」= 把旧内容写回去（恢复前同样先快照当前内容，天然可逆）。
//
// 与裁决的关系（防跑偏）：
// - 不是 git：本地 git 已被 SAF 裁决掉（H 系裁决 1，content URI vs java.io.File）；
//   这里是纯 store 读写的隐形历史（Claude Code checkpoint 的等价物）。
// - 不是分支：每 turn 自动建分支已被裁决（会污染 BranchForkRow）；本历史**不进
//   分支 UI**，恢复入口在文件层。
// - 与 H3 的关系：并存不合并——H3 的 rollback/<ts>.json 是「推送级」快照（含
//   sha/commit 语义），本模块是「工具级」快照（路径级）；恢复入口各自独立，
//   两者数据格式与保留期不同，强行合并只会让两边测试互相掣肘（登记理由）。
//
// 存储形态（两文件分层，读改写只动其一）：
//   .easychat/file-history/index.json   —— 元数据数组（上限 HISTORY_MAX 条，超出丢最旧）
//   .easychat/file-history/entries/<id>.json —— 单条旧内容（id = <ts>-<rand>）
//
// 安全边界：恢复入口**不做成 agent 工具**——历史改写只走 UI/宿主，防止模型自己
// 篡改历史；快照失败不阻塞写入（尽力而为，写主流程优先）。

export const FILE_HISTORY_DIR = '.easychat/file-history';
export const FILE_HISTORY_INDEX = `${FILE_HISTORY_DIR}/index.json`;
export const FILE_HISTORY_ENTRIES_DIR = `${FILE_HISTORY_DIR}/entries`;
// 上限：200 条元数据；单条旧内容超过 HISTORY_ENTRY_MAX_CHARS 只记长度（不可恢复，
// 如实标记 restorable: false）——防超大文件把 SAF 写爆。
export const HISTORY_MAX = 200;
export const HISTORY_ENTRY_MAX_CHARS = 256 * 1024;
export const FILE_HISTORY_SOURCES = Object.freeze(['tool', 'push-baseline']);

function entryPath(id) {
  return `${FILE_HISTORY_ENTRIES_DIR}/${String(id).replace(/[^a-z0-9-]/gi, '')}.json`;
}

// 纯函数：元数据条目收敛（字段白名单 + 大小标记）。坏输入 → null。
export function normalizeHistoryEntry(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const id = String(source.id || '');
  const path = String(source.path || '');
  if (!id || !path) return null;
  const size = Math.max(0, Math.floor(Number(source.size)) || 0);
  return {
    id,
    path,
    source: FILE_HISTORY_SOURCES.includes(source.source) ? source.source : 'tool',
    size,
    // 内容超限被剥离时 restorable 为 false——恢复入口据此如实提示。
    restorable: source.restorable !== false,
    at: Math.max(0, Math.floor(Number(source.at)) || 0),
  };
}

// 纯函数：轮换——index 超出上限时返回应删除的条目 id 列表（最旧优先）。
export function historyRotationDeletes(index, keep = HISTORY_MAX) {
  return (Array.isArray(index) ? index : [])
    .slice(Math.max(1, Math.floor(Number(keep)) || HISTORY_MAX))
    .map(item => item.id);
}

// 内部：读 index（不存在/坏 → 空数组）。
async function readIndex(store, characterId) {
  try {
    const result = await store.readWorkspaceFile({ characterId, path: FILE_HISTORY_INDEX });
    const parsed = JSON.parse(String((result && result.content) || '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

// IO：读整个索引（工作区回退规划用，见 workspace/rewind.js）。不存在/坏 → 空数组。
export async function readFileHistoryIndex(store, characterId) {
  return readIndex(store, characterId);
}

// 内部：写 index（失败静默——旁路机制）。
async function writeIndex(store, characterId, index) {
  try {
    await store.writeWorkspaceFile({
      characterId,
      path: FILE_HISTORY_INDEX,
      content: JSON.stringify(index),
    });
    return true;
  } catch (error) {
    return false;
  }
}

// IO：记录一条写前快照。oldContent 为空字符串表示「新建」（同样记录，删除可逆）。
// 返回 { ok, id }；失败 { ok: false }（绝不抛错——快照尽力而为，写主流程优先）。
export async function recordFileHistory(store, characterId, { path, oldContent, source = 'tool', at = 0 } = {}) {
  if (!store || typeof store.writeWorkspaceFile !== 'function') return { ok: false };
  const target = String(path || '').trim();
  if (!target) return { ok: false };
  const content = oldContent === null || oldContent === undefined ? '' : String(oldContent);
  const restorable = content.length <= HISTORY_ENTRY_MAX_CHARS;
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const at1 = Number.isFinite(Number(at)) && Number(at) > 0 ? Math.floor(Number(at)) : Date.now();
  try {
    // 条目文件：内容在限额内才落盘（超限只留元数据，restorable: false）。
    await store.writeWorkspaceFile({
      characterId,
      path: entryPath(id),
      content: JSON.stringify({ id, path: target, content: restorable ? content : '', at: at1 }),
    });
    const index = await readIndex(store, characterId);
    const meta = normalizeHistoryEntry({
      id,
      path: target,
      source,
      size: content.length,
      restorable,
      at: at1,
    });
    if (!meta) return { ok: false };
    // 轮换要基于**挤出前**的完整列表：next 已被截到上限，从它算删除会漏掉
    // 刚被挤出的那几条（它们的条目文件就永远残留了）。
    const merged = [meta, ...index];
    const next = merged.slice(0, HISTORY_MAX);
    await writeIndex(store, characterId, next);
    for (const stale of historyRotationDeletes(merged, HISTORY_MAX)) {
      try {
        await store.deleteFile({ characterId, path: entryPath(stale) });
      } catch (error) {}
    }
    return { ok: true, id };
  } catch (error) {
    return { ok: false };
  }
}

// IO：某路径的历史（最新在前，最多 limit 条元数据）。
export async function listFileHistory(store, characterId, path, { limit = 20 } = {}) {
  const index = await readIndex(store, characterId);
  const target = String(path || '');
  return index
    .filter(item => item && item.path === target)
    .slice(0, Math.max(1, Math.floor(Number(limit)) || 20));
}

// IO：读单条旧内容（元数据 + 内容文件；超限条目如实返回 content: null）。
// 注意：只验 id——path 在 index 里（normalize 的 path 检查不适用于"按 id 查"）。
export async function readFileHistoryEntry(store, characterId, id) {
  const entryId = String(id || '').trim();
  if (!entryId) return null;
  try {
    const index = await readIndex(store, characterId);
    const found = index.find(item => item && item.id === entryId);
    if (!found) return null;
    const result = await store.readWorkspaceFile({ characterId, path: entryPath(entryId) });
    const parsed = JSON.parse(String((result && result.content) || '{}'));
    const restorable = found.restorable !== false && typeof parsed.content === 'string';
    return {
      id: entryId,
      path: found.path,
      source: found.source,
      at: found.at,
      size: found.size,
      restorable,
      content: restorable ? parsed.content : null,
    };
  } catch (error) {
    return null;
  }
}

// IO：恢复某条旧内容——**恢复前先快照当前内容**（天然可逆：再恢复一次就回去）。
// currentContent：调用方读好的"现在"内容（null 表示读不到——快照会记 restorable:false）。
export async function restoreFileHistory(store, characterId, id, { currentContent = null } = {}) {
  const entry = await readFileHistoryEntry(store, characterId, id);
  if (!entry) return { ok: false, reason: 'not-found' };
  if (entry.restorable !== true || typeof entry.content !== 'string') {
    return { ok: false, reason: 'not-restorable' };
  }
  // 恢复前快照"现在"（可逆性：恢复错了再恢复一次就回今天）。
  if (currentContent !== null) {
    await recordFileHistory(store, characterId, {
      path: entry.path,
      oldContent: currentContent,
      source: 'tool',
    });
  }
  try {
    await store.writeWorkspaceFile({
      characterId,
      path: entry.path,
      content: entry.content,
    });
    return { ok: true, restoredPath: entry.path };
  } catch (error) {
    return { ok: false, reason: 'write-failed' };
  }
}
