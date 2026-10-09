// 会话事件流（E4 一期，spec 2026-10-10-agent-maturity）：append-only 审计线索。
//
// 存哪：`.easychat/sessions/<sessionId>.jsonl`（SAF 落盘，绕开 AsyncStorage 的
// 体积上限；UI 热数据仍以 AsyncStorage 消息为准，jsonl 只追加不回读）。
// 一行一个事件（JSONL）：{ id, type, ts, parentEventId, ...payload }。
//
// **只写不读回**：事件流是审计与导出用的旁路，绝不参与消息渲染——写失败静默
//（事件流不能成为消息链路的故障源），旧会话不迁移。
//
// 与分支系统的关系（E4 二期裁决，已核实）：消息级分叉/切换已由 chat/branchTree.js
// + storage/sessionBranches.js 提供；事件流**不另起一套分支树**，只记录发生过的
// 事实（含 branch 相关动作，作为审计线索）。
//
// 存储限制（如实登记）：SAF 的 store 只有「读全量 / 写全量」，没有 append 原语——
// 这里的「追加」= 读回 + 拼接 + 写回。事件行很小（每条 ~200B），千条级 = 200KB，
// 每轮一次的读改写成本可接受；等文件真的变大再考虑分片（审查待办留痕）。

export const SESSIONS_DIR = '.easychat/sessions';
export const SESSION_EVENT_TYPES = Object.freeze([
  'user', 'assistant', 'tool_call', 'tool_result',
  'plan_update', 'mode_change', 'compaction', 'branch_fork',
]);
// 单文件保护上限：超过后不再追加（防止无限增长把工作区写爆）——如实返回 false。
export const SESSION_EVENTS_MAX_BYTES = 512 * 1024;

export function sessionEventsPath(sessionId) {
  const id = String(sessionId || '').trim().replace(/[^A-Za-z0-9_-]/g, '_');
  return `${SESSIONS_DIR}/${id || 'unknown'}.jsonl`;
}

// 纯函数：构造一条事件（裁剪 payload、补 id/ts/parentEventId）。
// 未知 type 照收（前向兼容）；payload 里的 undefined 不落盘。
export function createSessionEvent(type, payload = {}, { parentEventId = '', now = 0, seq = 0 } = {}) {
  const kind = String(type || '').trim() || 'unknown';
  const at = Number.isFinite(Number(now)) && Number(now) > 0 ? Math.floor(Number(now)) : Date.now();
  const event = {
    id: `ev-${at.toString(36)}-${Math.max(0, Math.floor(Number(seq)) || 0).toString(36)}`,
    type: kind,
    ts: at,
  };
  if (parentEventId) event.parentEventId = String(parentEventId);
  const source = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  for (const key of Object.keys(source)) {
    const value = source[key];
    if (value === undefined) continue;
    if (key === 'id' || key === 'type' || key === 'ts') continue; // 保留字段不可被 payload 覆盖
    event[key] = value;
  }
  return event;
}

// 纯函数：事件 → JSONL 行（不带换行符；序列化失败返回空串，调用方跳过）。
export function serializeSessionEvent(event) {
  try {
    return JSON.stringify(event);
  } catch (error) {
    return '';
  }
}

// 纯函数：JSONL 文本 → 事件数组（坏行跳过——导出/审计侧容错，坏行不能整份读不出）。
export function parseSessionEvents(text) {
  const events = [];
  for (const line of String(text == null ? '' : text).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) events.push(parsed);
    } catch (error) {}
  }
  return events;
}

// IO：读会话事件（不存在/读失败 → 空数组，绝不抛错）。
export async function readSessionEvents(store, characterId, sessionId) {
  if (!store || typeof store.readWorkspaceFile !== 'function') return [];
  try {
    const result = await store.readWorkspaceFile({
      characterId,
      path: sessionEventsPath(sessionId),
    });
    return parseSessionEvents(result && result.content);
  } catch (error) {
    return [];
  }
}

// IO：追加一条事件（读回 + 拼接 + 写回，见头注限制说明）。
// 返回写入的事件；任何失败返回 null（旁路机制绝不抛错）。
export async function appendSessionEvent(store, characterId, sessionId, type, payload = {}) {
  if (!store || typeof store.writeWorkspaceFile !== 'function') return null;
  try {
    const path = sessionEventsPath(sessionId);
    let existing = '';
    try {
      const result = await store.readWorkspaceFile({ characterId, path });
      existing = String((result && result.content) || '');
    } catch (error) {
      existing = ''; // 首次写入：文件不存在是常态
    }
    if (existing.length > SESSION_EVENTS_MAX_BYTES) return null; // 到上限停止追加（如实失败）
    const seq = existing ? existing.split('\n').filter(Boolean).length : 0;
    const event = createSessionEvent(type, payload, { seq });
    const line = serializeSessionEvent(event);
    if (!line) return null;
    const next = existing ? `${existing.replace(/\n?$/, '\n')}${line}\n` : `${line}\n`;
    await store.writeWorkspaceFile({ characterId, path, content: next });
    return event;
  } catch (error) {
    return null;
  }
}

// 纯函数：事件数组 → 导出文本（带注释头，方便人读与存档）。
export function buildSessionEventsExport(events, { title = '' } = {}) {
  const list = Array.isArray(events) ? events : [];
  const header = [
    `# 会话事件流导出${title ? `：${title}` : ''}`,
    `# 事件数：${list.length}`,
    `# 导出时间：${new Date().toISOString()}`,
    '# 每行一个 JSON 事件（JSONL）。',
  ].join('\n');
  const body = list.map(item => serializeSessionEvent(item)).filter(Boolean).join('\n');
  return body ? `${header}\n${body}\n` : `${header}\n`;
}
