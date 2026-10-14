// 悬浮窗对话日志的**纯解析层**（M2.5）：零依赖，可在 Node 里直接 import 做真行为测试。
//
// 为什么单独一个文件：读取那半边要碰 expo-file-system 与 NativeModules（RN 运行时），
// 一旦与解析写在同一个模块里，「解析规则」就没法在 Node 里直测了
//（FIX-7 已踩过同款坑：可测性由模块边界决定，不由调用方纪律决定）。
//
// 日志由原生大脑（OverlayBrain.kt）按行写：{ t, ms, role, text, persona?, image? }

// 与 OverlayBrain.kt 的 historyFile() 同名同目录。
export const OVERLAY_THREAD_LOG_NAME = 'overlay-thread.jsonl';

// 归档分片（滚动切分）：overlay-thread-1.jsonl、overlay-thread-2.jsonl…
export const OVERLAY_LOG_PATTERN = /^overlay-thread(-\d+)?\.jsonl$/;

// 与 threads.js 的 THREAD_ROLE_USER / THREAD_ROLE_CHARACTER 逐字一致。
// 刻意不 import threads.js：那个模块会拉进 AsyncStorage，本地就测不了了。
// 一致性由 tests/overlayThreadLog.test.mjs 的「常量对齐」用例钉住。
export const OVERLAY_ROLE_USER = 'user';
export const OVERLAY_ROLE_CHARACTER = 'assistant';

export const OVERLAY_ENTRY_TEXT_MAX = 2000;

/**
 * 解析 JSONL 文本 → threads.js 条目数组（`{ id, role, text, imageUri, at }`）。
 *
 * - `id` 用 `前缀-行号`：这是**追加型**文件，行号稳定，天然可做幂等键
 *   （同一份日志重复读入不会产生重复条目）。
 * - `persona` 非空时过滤掉别的角色的行：切换角色后不该把上一个角色的对话带进来。
 *   旧版本没有该字段的行视为通用（不过滤），兼容升级前的日志。
 * - 坏行/缺字段一律跳过：一行脏数据不该废掉整场对话。
 */
export function parseOverlayThreadLines(rawText, { persona = '', idPrefix = 'ovl' } = {}) {
  const wanted = String(persona || '').trim();
  const entries = [];
  const lines = String(rawText || '').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    let parsed = null;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const linePersona = String(parsed.persona || '').trim();
    if (wanted && linePersona && linePersona !== wanted) continue;
    const text = String(parsed.text || '').trim().slice(0, OVERLAY_ENTRY_TEXT_MAX);
    if (!text) continue;
    entries.push({
      id: `${idPrefix}-${index}`,
      role: parsed.role === OVERLAY_ROLE_USER ? OVERLAY_ROLE_USER : OVERLAY_ROLE_CHARACTER,
      text,
      imageUri: String(parsed.image || ''),
      at: Math.floor(Number(parsed.ms)) || 0,
    });
  }
  return entries;
}
