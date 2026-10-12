// UI 槽位注册表（slot registry）——「可注册 UI」的最小内核（差距 #2）。
//
// 形状借自 DSH 的类型化 slot，但只取**最小内核**：一个注册表 + 贡献自注册 + 优先级冲突裁决。
// 渲染层按 `kind` 取该槽位的贡献列表并画出来——于是「谁能往对话头部/设置面板加东西」不再
// 取决于改哪个大文件，而取决于**谁注册了**。
//
// 纯逻辑、零 IO、可 Node 直测。冲突口径（对齐 DSH 的 extension > builtin > fallback）：
// 同一 (kind, id) 被多次注册时，优先级高者胜；同优先级保留先到者并记录一条 conflict。

import { SLOT_KIND_UNWIRED_REASON } from './manifest.js';
// 接线表（纯数据）：默认就按它判「这个 kind 界面上有没有落点」。
import { UNWIRED_SLOT_KINDS } from './slotKinds.js';

export const SLOT_PRIORITY = Object.freeze({ fallback: 1, builtin: 2, extension: 3 });

// 未接线槽位的显式标记条目 id：render() 遇到未接线的 kind 时，把它放在列表最前面，
// 调用方据此知道「这些贡献注册成功了，但界面上没有落点」。
export const SLOT_UNWIRED_MARKER_ID = '__unwired__';

export function priorityOf(source) {
  return SLOT_PRIORITY[String(source || '')] || SLOT_PRIORITY.fallback;
}

// unwiredKinds：未接线的 kind 清单，**默认取自接线表的派生结果**（workspace/plugins/slotKinds.js），
// 不在这里手写第二份。参数保留是为了可测/可注入（例如只想验某一种 kind 的场景）。
export function createSlotRegistry({ unwiredKinds = UNWIRED_SLOT_KINDS } = {}) {
  // key = `${kind}::${id}`，避免同一 kind 下不同 id 互相顶掉。
  const entries = new Map();
  const conflicts = [];
  const unwired = new Set(
    (Array.isArray(unwiredKinds) ? unwiredKinds : []).map(kind => String(kind || ''))
  );

  function add({ kind, id, source = 'fallback', contribution = {} } = {}) {
    const slotKind = String(kind || '');
    const slotId = String(id || contribution.id || '');
    if (!slotKind || !slotId) return { ok: false, error: 'kind/id 不能为空' };
    const key = `${slotKind}::${slotId}`;
    const priority = priorityOf(source);
    const existing = entries.get(key);
    if (existing) {
      if (priority > existing.priority) {
        entries.set(key, { kind: slotKind, id: slotId, source, priority, contribution });
        return { ok: true, replaced: true };
      }
      conflicts.push({ kind: slotKind, id: slotId, source, kept: existing.source });
      return { ok: false, conflict: true, kept: existing.source };
    }
    entries.set(key, { kind: slotKind, id: slotId, source, priority, contribution });
    return { ok: true };
  }

  // 渲染一个槽位的贡献列表：按优先级降序、同优先级按注册顺序。
  // 未接线的 kind **不静默返回空/列表**：显式在最前面回一条「未接线」标记，
  // 否则调用方很容易把「render 出来了」误当成「用户能看到」——这正是插件系统里最难发现的
  // 假接线（manifest 收下了、注册表也 render 了，界面上却永远没有落点，而且不报错）。
  function render(kind) {
    const slotKind = String(kind || '');
    const list = [...entries.values()]
      .filter(item => item.kind === slotKind)
      .sort((a, b) => b.priority - a.priority)
      .map(item => ({ ...item.contribution, kind: item.kind, id: item.id, source: item.source }));
    if (!unwired.has(slotKind)) return list;
    return [
      {
        id: SLOT_UNWIRED_MARKER_ID,
        kind: slotKind,
        source: 'builtin',
        wired: false,
        reason: SLOT_KIND_UNWIRED_REASON,
      },
      ...list,
    ];
  }

  function listSlots() {
    const counts = {};
    for (const item of entries.values()) counts[item.kind] = (counts[item.kind] || 0) + 1;
    return counts;
  }

  function listContributions() {
    return [...entries.values()].map(item => ({ kind: item.kind, id: item.id, source: item.source }));
  }

  function size() { return entries.size; }
  function listConflicts() { return conflicts.slice(); }
  function clear() { entries.clear(); conflicts.length = 0; }

  return { add, render, listSlots, listContributions, size, listConflicts, clear };
}
