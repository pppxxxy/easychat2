// 主动消息落库的纯函数：id 派生与幂等合并。
// 与原生 PendingMessage 的 id 规则保持一致（slotId + 日期），使重复消费不产生重复消息。

function pad(value) {
  return String(value).padStart(2, '0');
}

// 本地日期（YYYY-MM-DD）：主动消息按「每槽每日一条」对齐，用本地时区避免跨时区错位。
export function buildProactiveMessageId(slotId, date = new Date()) {
  const id = String(slotId || '').trim();
  if (!id) return '';
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  return `${id}-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 把一条主动消息并入会话消息数组：id 已存在则跳过（幂等），否则按时间追加。
export function mergeProactiveMessage(messages, incoming) {
  const list = Array.isArray(messages) ? messages : [];
  const source = incoming && typeof incoming === 'object' ? incoming : null;
  if (!source) return list;
  const id = String(source.id || '');
  const text = String(source.text || '').trim();
  if (!id || !text) return list;
  if (list.some(item => item && String(item.id || '') === id)) return list;
  const timestamp = Number(source.timestamp) || Date.now();
  return [
    ...list,
    {
      id,
      role: 'assistant',
      text,
      timestamp,
      proactive: true,
    },
  ];
}

// 归一化原生 consumePendingMessages 的返回值。
// 新架构 Interop 下返回值不一定是普通 JS 数组：可能以类数组的 JSI HostObject 形式回到
// JS（Array.isArray 为 false，但 length/索引可读），原生契约也可能直接回 JSON 字符串。
// 逐一兼容，避免因 Array.isArray 不成立而静默丢弃待写消息（曾导致主动消息永不落库）。
export function normalizePendingMessages(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      return [];
    }
  }
  if (raw && typeof raw === 'object') {
    const length = Number(raw.length);
    if (Number.isFinite(length) && length > 0) {
      const list = [];
      for (let index = 0; index < length; index += 1) {
        if (raw[index] != null) list.push(raw[index]);
      }
      return list;
    }
    // 兜底：原生异常路径可能只回传一条消息对象
    if (raw.id && raw.roleId) return [raw];
  }
  return [];
}

