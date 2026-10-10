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
// 持久化格式版本：跨会话黑板文件（.easychat/board/board.json）的 schema 标记。
export const BLACKBOARD_VERSION = 1;

// 主题归一：小写、空白折叠成连字符、截断——让「用户列表」「用户 列表」指向同一主题。
export function normalizeTopic(topic) {
  return String(topic == null ? '' : topic)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .slice(0, 64);
}

function normalizeEntry(entry, seq) {
  const text = String((entry && entry.text) || '').trim().slice(0, BLACKBOARD_TEXT_MAX);
  if (!text) return null;
  return {
    seq,
    from: String((entry && entry.from) || '匿名').slice(0, 48),
    text,
    at: Number(entry && entry.at) || Date.now(),
  };
}

// 创建一块黑板。initial 是此前 serialize() 的结果（跨会话沉淀）——按其播种，序号续接。
// 返回 { post, read, topics, size, serialize, hasContent }（全同步）。
export function createBlackboard({ initial } = {}) {
  const board = new Map();
  let seq = 0;
  const seed = initial && typeof initial === 'object' && initial.topics && typeof initial.topics === 'object'
    ? initial.topics
    : null;
  if (seed) {
    for (const [topic, list] of Object.entries(seed)) {
      if (board.size >= BLACKBOARD_MAX_TOPICS) break;
      const key = normalizeTopic(topic);
      if (!key || board.has(key)) continue;
      const bucket = [];
      for (const entry of (Array.isArray(list) ? list : [])) {
        seq += 1;
        const normalized = normalizeEntry(entry, seq);
        if (normalized) bucket.push(normalized);
      }
      if (bucket.length) board.set(key, bucket.slice(-BLACKBOARD_MAX_ENTRIES));
    }
  }
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
    hasContent() {
      for (const bucket of board.values()) if (bucket.length) return true;
      return false;
    },
    // 序列化成可落盘/可播种的纯对象（跨会话黑板文件用）。
    serialize() {
      const topics = {};
      for (const [topic, bucket] of board) {
        topics[topic] = bucket.map(item => ({ seq: item.seq, from: item.from, text: item.text, at: item.at }));
      }
      return { version: BLACKBOARD_VERSION, updatedAt: Date.now(), topics };
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

// 纯函数：把一块黑板归纳成展示用快照 [{ topic, messages: [{ from, text, at }] }]（按主题名排序）。
// 供工作区设置里的「团队记忆」查看器读取——黑板本身是隐藏文件，这是它的可视化出口。
export function boardTopics(board) {
  if (!board || typeof board.serialize !== 'function') return [];
  const topics = (board.serialize() || {}).topics || {};
  return Object.keys(topics).sort().map(topic => ({
    topic,
    messages: (Array.isArray(topics[topic]) ? topics[topic] : []).map(item => ({
      from: String((item && item.from) || ''),
      text: String((item && item.text) || ''),
      at: Number((item && item.at) || 0),
    })),
  }));
}

// 团队协作时追加到子代理系统提示的说明（无黑板时调用方不追加）。
export function boardPromptSuffix() {
  return '\n【团队通信】你和其它分身共享一块黑板：用 board_post({topic, text}) 把进展/发现/'
    + '中间结论发布到某个主题下，用 board_read({topic}) 读取同伴写的内容。'
    + '黑板可能已有此前会话沉淀的内容——开始前先 board_read 你关心的主题，避免重复劳动。'
    + '需要互相传递结果时就用它，不要假设同伴能看到你的中间过程。';
}
