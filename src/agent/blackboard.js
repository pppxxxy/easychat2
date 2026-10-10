// 共享黑板（agent 团队通信原语，spec 2026-10-11-workspace-parity P0 多智能体）。
//
// 干什么：一次 run_workflow / run_subagent 批次里的多个分身共享一块**内存黑板**——
// 各自用 board_post 把进展/发现/中间结论写到某个主题下，用 board_read 读取同伴写的内容。
// 这补上了「子代理间自由通信」：DAG 的 dependsOn 只能沿声明好的边传结论，黑板允许任何
// 分身读任何主题（无需声明依赖，也不受拓扑层限制）。
//
// 纯逻辑、零 IO、可 Node 直测；存储有界（主题数/条数/单条长度/读取长度都有上限，
// 防止一个跑飞的分身把内存撑爆）。

export const BLACKBOARD_MAX_TOPICS = 16;
export const BLACKBOARD_MAX_ENTRIES = 32;
export const BLACKBOARD_TEXT_MAX = 2000;
export const BLACKBOARD_READ_MAX = 8000;

// 主题归一：小写、空白折叠成连字符、截断——让「用户列表」「用户 列表」指向同一主题。
export function normalizeTopic(topic) {
  return String(topic == null ? '' : topic)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .slice(0, 64);
}

// 创建一块黑板。返回 { post, read, topics, size }（全同步）。
export function createBlackboard() {
  const board = new Map();
  let seq = 0;
  return {
    post({ topic, from, text } = {}) {
      const key = normalizeTopic(topic);
      if (!key) return { ok: false, error: 'topic 不能为空。' };
      const body = String(text == null ? '' : text).trim().slice(0, BLACKBOARD_TEXT_MAX);
      if (!body) return { ok: false, error: 'text 不能为空。' };
      const list = board.get(key);
      if (!list && board.size >= BLACKBOARD_MAX_TOPICS) {
        return { ok: false, error: `黑板主题已达上限 ${BLACKBOARD_MAX_TOPICS} 个。` };
      }
      const bucket = list || [];
      seq += 1;
      bucket.push({ seq, from: String(from || '匿名').slice(0, 48), text: body, at: Date.now() });
      // 只保留最近 N 条：旧消息滚出（与其它环形缓冲同款纪律）。
      while (bucket.length > BLACKBOARD_MAX_ENTRIES) bucket.shift();
      board.set(key, bucket);
      return { ok: true, topic: key, seq, count: bucket.length };
    },
    read({ topic, since } = {}) {
      const key = normalizeTopic(topic);
      if (!key) return { ok: false, error: 'topic 不能为空。', messages: [], latest: 0 };
      const bucket = board.get(key) || [];
      const after = Number.isFinite(Number(since)) ? Number(since) : 0;
      const messages = bucket.filter(item => item.seq > after);
      const latest = bucket.length ? bucket[bucket.length - 1].seq : 0;
      return { ok: true, topic: key, messages, latest };
    },
    topics() {
      return [...board.keys()].sort();
    },
    size() {
      return board.size;
    },
  };
}

// 把 read 结果格式化成模型可读文本（超长截断）。
export function formatBoardMessages(topic, messages) {
  const list = Array.isArray(messages) ? messages : [];
  if (list.length === 0) return `主题「${topic}」暂无消息。`;
  const lines = list.map(item => `[${item.seq}] ${item.from}：${item.text}`);
  const text = lines.join('\n');
  return text.length > BLACKBOARD_READ_MAX
    ? `${text.slice(0, BLACKBOARD_READ_MAX)}…（已截断，可用 since 读取更新的条目）`
    : text;
}

// 团队协作时追加到子代理系统提示的说明（无黑板时调用方不追加）。
export function boardPromptSuffix() {
  return '\n【团队通信】你和其它分身共享一块黑板：用 board_post({topic, text}) 把进展/发现/'
    + '中间结论发布到某个主题下，用 board_read({topic}) 读取同伴写的内容。'
    + '需要互相传递结果时就用它，不要假设同伴能看到你的中间过程。';
}
