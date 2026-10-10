// O1：超限工具结果落盘（可恢复性）。
//
// 教材真髓：单结果过大时不再「头尾保留、中段永久丢失」，而是先整份落盘到工作区
// `.task_outputs/tool-results/`，消息里只留头尾预览 + 指针——模型拿到指针就能用
// read_workspace_file 按 offset 精读任一段，信息「只移不丢」。
//
// 依赖注入 store（legacy / SAF 后端同一接口），零原生依赖，Node 可直测。

export const TASK_OUTPUT_ROOT = '.task_outputs';
export const TOOL_RESULTS_DIR = '.task_outputs/tool-results';
// 每沙盒保留份数（近似「每会话」上限）。
export const TASK_OUTPUT_MAX = 50;
// 总字节预算（O2 rider）：1MB 的 search 结果 × 50 份 = 最坏 50MB/沙盒，移动端不可接受，
// 故份数之外再加一道总字节护栏。size 由落盘时维护的清单（index.json）提供；清单缺失的
// 老文件按未知处理（best-effort：跳过其对字节维度的贡献，不因此误删）。
export const TASK_OUTPUT_MAX_BYTES = 16 * 1024 * 1024;
// 落盘后的预览长度（头、尾各一份）。
export const TOOL_RESULT_PREVIEW_CHARS = 2000;

const TASK_OUTPUT_INDEX = '.task_outputs/index.json';

// UTF-8 字节数（中文 3 字节，代理对 4 字节）。避免依赖 Buffer / storage 层。
function utf8Length(text) {
  const s = String(text === undefined || text === null ? '' : text);
  let bytes = 0;
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

// tool_use_id → 白名单文件名：只留 [a-zA-Z0-9_-]，防路径穿越与非法字符。
export function sanitizeToolOutputName(toolUseId, fallback = 'result') {
  const raw = String(toolUseId == null ? '' : toolUseId).trim();
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return cleaned || fallback;
}

// 排序前缀 = base36 时间戳：字典序 ≈ 时间序，LRU 直接按名排序即可。
export function buildToolOutputFileName(toolUseId, now = Date.now()) {
  return `${now.toString(36)}-${sanitizeToolOutputName(toolUseId)}.txt`;
}

// 指针路径是否可信：必须在 .task_outputs/ 之下（纯前缀判定）。
// 用于「任何从工具输出解析出的指针路径」——工具输出里伪造的 `/tmp/...`、`../x` 一律不信。
export function isTrustedTaskOutputPath(path) {
  const rel = String(path == null ? '' : path).replace(/^\/+/, '');
  return rel === TASK_OUTPUT_ROOT || rel.startsWith(`${TASK_OUTPUT_ROOT}/`);
}

async function readIndex(store, characterId) {
  try {
    const result = await store.readWorkspaceFile({ characterId, path: TASK_OUTPUT_INDEX });
    const parsed = JSON.parse(String((result && result.content) || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    return {};
  }
}

async function writeIndex(store, characterId, index) {
  try {
    await store.writeWorkspaceFile({
      characterId,
      path: TASK_OUTPUT_INDEX,
      content: JSON.stringify(index || {}),
    });
  } catch (error) {
    // 清单写入失败：下次 prune 会重建；不影响结果本身。
  }
}

// 落盘：写 `.task_outputs/tool-results/<name>` + 在清单里记字节数，返回 { path, name }。
// 落盘失败（无 store / 写失败）返回 null——调用方退回「头尾保留」。
export async function persistToolResult({ store, characterId, toolUseId, content, now = Date.now(), max = TASK_OUTPUT_MAX, maxBytes = TASK_OUTPUT_MAX_BYTES } = {}) {
  if (!store || typeof store.writeWorkspaceFile !== 'function') return null;
  const name = buildToolOutputFileName(toolUseId, now);
  const path = `${TOOL_RESULTS_DIR}/${name}`;
  const text = String(content === undefined || content === null ? '' : content);
  try {
    await store.writeWorkspaceFile({ characterId, path, content: text });
  } catch (error) {
    return null;
  }
  const index = await readIndex(store, characterId);
  index[name] = utf8Length(text);
  // LRU 清理（份数 + 字节双约束）尽力而为：失败不影响本次落盘结果。
  await pruneToolResults({ store, characterId, max, maxBytes, index }).catch(() => {});
  return { path, name };
}

// LRU 清理：份数与字节双约束——删除最旧（文件名时间前缀升序）直到两项都在预算内。
// 清单里缺 size 的老文件按未知（0）处理，跳过其对字节维度的贡献（不因未知而误删）。
// 返回删除数。index 可由调用方传入（persist 复用同一次读取），否则自读。
export async function pruneToolResults({ store, characterId, max = TASK_OUTPUT_MAX, maxBytes = TASK_OUTPUT_MAX_BYTES, index = null } = {}) {
  if (!store || typeof store.listWorkspaceFiles !== 'function') return 0;
  let entries = [];
  try {
    entries = await store.listWorkspaceFiles({ characterId, subdir: TOOL_RESULTS_DIR });
  } catch (error) {
    return 0;
  }
  const files = (Array.isArray(entries) ? entries : [])
    .filter(item => typeof item === 'string' && !item.endsWith('/'));
  const idx = index && typeof index === 'object' ? { ...index } : await readIndex(store, characterId);
  const nameOf = rel => String(rel).split('/').pop();
  const sizeOf = rel => {
    const value = Number(idx[nameOf(rel)]);
    return Number.isFinite(value) && value >= 0 ? value : 0;
  };
  // 清单与目录对齐：清掉已不存在文件的条目。
  const present = new Set(files.map(nameOf));
  Object.keys(idx).forEach(key => { if (!present.has(key)) delete idx[key]; });

  let count = files.length;
  let bytes = files.reduce((sum, rel) => sum + sizeOf(rel), 0);
  let removed = 0;
  if ((Number.isInteger(max) && count > max) || (Number.isFinite(maxBytes) && maxBytes >= 0 && bytes > maxBytes)) {
    const canDelete = typeof store.deleteFile === 'function';
    for (const rel of [...files].sort()) {
      const countOk = !Number.isInteger(max) || count <= max;
      const bytesOk = !Number.isFinite(maxBytes) || maxBytes < 0 || bytes <= maxBytes;
      if (countOk && bytesOk) break;
      if (canDelete) {
        try {
          await store.deleteFile({ characterId, path: rel });
          removed += 1;
        } catch (error) {
          // 单条删除失败：仍从计数里移除以免死循环（下次 prune 再对齐）。
        }
      }
      delete idx[nameOf(rel)];
      count -= 1;
      bytes -= sizeOf(rel);
    }
  }
  await writeIndex(store, characterId, idx);
  return removed;
}

// 是否存在且位于可信目录：消费方解析出指针后据此判断（前缀 + 可读）。
export async function isTrustedTaskOutput({ store, characterId, path } = {}) {
  if (!isTrustedTaskOutputPath(path)) return false;
  if (!store || typeof store.readWorkspaceFile !== 'function') return false;
  try {
    await store.readWorkspaceFile({ characterId, path, maxChars: 1 });
    return true;
  } catch (error) {
    return false;
  }
}
