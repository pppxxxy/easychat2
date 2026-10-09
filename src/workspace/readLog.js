// 已读文件登记（A5，能力升级任务书：会话级 working memory 最小版）。
//
// 每轮系统提示附一行「本会话已读：a.js(3.2k)、b.py(0.8k)…」，两个价值：
// 1. **防重复读**——模型知道自己读过哪些文件，不必反复 read 同一个；
// 2. **截断自觉**——被截断过的文件出现在清单里，提醒它「上文可能不完整，
//    需要精确内容时用 offset 续读」。
//
// 存储是**会话内存**（不落盘、切对话即清）：它是「这次对话读过了什么」的临时状态，
// 不是长期记忆（那是 AGENTS.md 的职责）。上限 30 条 LRU，注入行有字符上限。

export const READ_LOG_LIMIT = 30;
export const READ_LOG_LINE_LIMIT = 600;

// 纯函数：字符数 → 紧凑展示（3.2k / 800）。
export function formatReadChars(chars) {
  const value = Math.max(0, Math.floor(Number(chars) || 0));
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

// 会话登记器（有轻状态但零 IO；"纯函数 + 薄壳"同款范式，可 Node 直测）。
export function createReadLog(limit = READ_LOG_LIMIT) {
  const max = Number.isInteger(limit) && limit > 0 ? limit : READ_LOG_LIMIT;
  const entries = new Map(); // path → { path, chars, at }，Map 插入序即 LRU 序
  return {
    record(path, chars) {
      const key = String(path == null ? '' : path).trim();
      if (!key) return;
      entries.delete(key); // 重读 → 移到最新（LRU：最近读的排在最后）
      entries.set(key, {
        path: key,
        chars: Math.max(0, Math.floor(Number(chars) || 0)),
        at: Date.now(),
      });
      while (entries.size > max) {
        const oldest = entries.keys().next().value;
        entries.delete(oldest);
      }
    },
    list() {
      return [...entries.values()];
    },
    clear() {
      entries.clear();
    },
  };
}

// 纯函数：登记条目 → 系统提示的一行（空 → 空串，不注入）。
export function formatReadLogLine(entries) {
  const list = (Array.isArray(entries) ? entries : []).filter(item => item && item.path);
  if (list.length === 0) return '';
  const parts = list.map(item => `${item.path}(${formatReadChars(item.chars)})`);
  let text = `本会话已读：${parts.join('、')}`;
  if (text.length > READ_LOG_LINE_LIMIT) text = `${text.slice(0, READ_LOG_LINE_LIMIT)}…`;
  return text;
}
