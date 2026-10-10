// O1：超限工具结果落盘（可恢复性）。
//
// 教材真髓：单结果过大时不再「头尾保留、中段永久丢失」，而是先整份落盘到工作区
// `.task_outputs/tool-results/`，消息里只留头尾预览 + 指针——模型拿到指针就能用
// read_workspace_file 按 offset 精读任一段，信息「只移不丢」。
//
// 依赖注入 store（legacy / SAF 后端同一接口），零原生依赖，Node 可直测。

export const TASK_OUTPUT_ROOT = '.task_outputs';
export const TOOL_RESULTS_DIR = '.task_outputs/tool-results';
// 每沙盒保留份数（近似「每会话」上限）：超出按文件名时间前缀 LRU 清理。
export const TASK_OUTPUT_MAX = 50;
// 落盘后的预览长度（头、尾各一份）。
export const TOOL_RESULT_PREVIEW_CHARS = 2000;

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

// 落盘：写 `.task_outputs/tool-results/<name>`，返回 { path, name }。
// 落盘失败（无 store / 写失败）返回 null——调用方退回「头尾保留」。
export async function persistToolResult({ store, characterId, toolUseId, content, now = Date.now(), max = TASK_OUTPUT_MAX } = {}) {
  if (!store || typeof store.writeWorkspaceFile !== 'function') return null;
  const name = buildToolOutputFileName(toolUseId, now);
  const path = `${TOOL_RESULTS_DIR}/${name}`;
  try {
    await store.writeWorkspaceFile({
      characterId,
      path,
      content: String(content === undefined || content === null ? '' : content),
    });
  } catch (error) {
    return null;
  }
  // LRU 清理尽力而为：失败不影响本次落盘结果。
  await pruneToolResults({ store, characterId, max }).catch(() => {});
  return { path, name };
}

// LRU 清理：按文件名（时间前缀）升序，超出 max 的从最旧删起。返回删除数。
export async function pruneToolResults({ store, characterId, max = TASK_OUTPUT_MAX } = {}) {
  if (!store || typeof store.listWorkspaceFiles !== 'function') return 0;
  if (!Number.isInteger(max) || max < 0) return 0;
  let entries = [];
  try {
    entries = await store.listWorkspaceFiles({ characterId, subdir: TOOL_RESULTS_DIR });
  } catch (error) {
    return 0;
  }
  const files = (Array.isArray(entries) ? entries : [])
    .filter(item => typeof item === 'string' && !item.endsWith('/'));
  if (files.length <= max) return 0;
  const toDelete = [...files].sort().slice(0, files.length - max);
  if (typeof store.deleteFile !== 'function') return 0;
  let removed = 0;
  for (const path of toDelete) {
    try {
      await store.deleteFile({ characterId, path });
      removed += 1;
    } catch (error) {
      // 单个删除失败继续。
    }
  }
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
