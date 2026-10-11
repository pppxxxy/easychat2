// N2 L3：压缩前完整历史归档（`.transcripts/*.jsonl`）。
//
// 破坏性替换（摘要）之前先把完整历史写盘，压缩消息附「完整历史：<path>」——信息只移不丢。
// 复用 O1 的目录纪律：时间前缀命名（字典序≈时间序）+ 保留最近 K 份 LRU 清理。
// store 注入（legacy / SAF 同一接口），零原生依赖，Node 可直测。

export const TRANSCRIPTS_DIR = '.transcripts';
export const TRANSCRIPT_KEEP = 5;

export function buildTranscriptName(now = Date.now()) {
  return `${Number(now).toString(36)}.jsonl`;
}

// 写归档：返回 { path, name }；失败返回 null（调用方据此不写「完整历史」指针）。
export async function writeTranscript({ store, characterId, content, now = Date.now(), keep = TRANSCRIPT_KEEP } = {}) {
  if (!store || typeof store.writeWorkspaceFile !== 'function') return null;
  const name = buildTranscriptName(now);
  const path = `${TRANSCRIPTS_DIR}/${name}`;
  try {
    await store.writeWorkspaceFile({ characterId, path, content: String(content === undefined || content === null ? '' : content) });
  } catch (error) {
    return null;
  }
  await pruneTranscripts({ store, characterId, keep }).catch(() => {});
  return { path, name };
}

// LRU：按文件名（时间前缀）升序，超出 keep 的从最旧删起。返回删除数。
export async function pruneTranscripts({ store, characterId, keep = TRANSCRIPT_KEEP } = {}) {
  if (!store || typeof store.listWorkspaceFiles !== 'function') return 0;
  if (!Number.isInteger(keep) || keep < 0) return 0;
  let entries = [];
  try {
    entries = await store.listWorkspaceFiles({ characterId, subdir: TRANSCRIPTS_DIR });
  } catch (error) {
    return 0;
  }
  const files = (Array.isArray(entries) ? entries : [])
    .filter(item => typeof item === 'string' && !item.endsWith('/'));
  if (files.length <= keep || typeof store.deleteFile !== 'function') return 0;
  const toDelete = [...files].sort().slice(0, files.length - keep);
  let removed = 0;
  for (const path of toDelete) {
    try {
      await store.deleteFile({ characterId, path });
      removed += 1;
    } catch (error) {
      // 单条失败继续。
    }
  }
  return removed;
}
