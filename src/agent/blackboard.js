// 团队通信与任务看板（多智能体协作原语，spec 2026-10-11-workspace-parity）。
//
// 三块能力，共用一个有界内存对象：
//   1. 共享黑板（board_post / board_read）——按主题广播中间结论，任何分身可读；
//   2. 直连消息（board_send / board_inbox）——点对点投递，补上「我只想告诉某个同伴」；
//   3. 任务看板（board_task）——共享任务清单，claim/complete 让分工可见、可认领（对齐
//      DSH 的团队共享任务看板）。
//
// 纯逻辑、零 IO、可 Node 直测；存储有界（主题/消息/任务数、单条长度都有上限，
// 防止一个跑飞的分身把内存撑爆）。跨会话沉淀走 serialize()/initial（见 boardStore.js）。

export const BLACKBOARD_MAX_TOPICS = 16;
export const BLACKBOARD_MAX_ENTRIES = 32;
export const BLACKBOARD_TEXT_MAX = 2000;
export const BLACKBOARD_READ_MAX = 8000;
export const BLACKBOARD_MAX_MESSAGES = 64;   // 单个收件箱最多保留的消息条数
export const TEAM_TASK_MAX = 32;             // 任务看板上限
export const TEAM_TASK_TITLE_MAX = 200;
// 持久化格式版本：跨会话黑板文件（.easychat/board/board.json）的 schema 标记。
// v2 起增加 messages / tasks 两块（v1 只有 topics）。
export const BLACKBOARD_VERSION = 2;

export const TASK_STATUSES = Object.freeze(['open', 'claimed', 'done']);

// 主题归一：小写、空白折叠成连字符、截断——让「用户列表」「用户 列表」指向同一主题。
export function normalizeTopic(topic) {
  return String(topic == null ? '' : topic)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .slice(0, 64);
}

// 代理人名归一（直连消息与任务归属用同一套）：去空白 + 小写，让「A」「a」指向同一人。
export function normalizeAgent(name) {
  return String(name == null ? '' : name).trim().toLowerCase().slice(0, 48);
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

function normalizeMessage(entry, seq) {
  const text = String((entry && entry.text) || '').trim().slice(0, BLACKBOARD_TEXT_MAX);
  const to = normalizeAgent(entry && entry.to);
  if (!text || !to) return null;
  return {
    seq,
    to,
    from: String((entry && entry.from) || '匿名').slice(0, 48),
    text,
    at: Number(entry && entry.at) || Date.now(),
  };
}

// 创建一块黑板 + 消息总线 + 任务看板。initial 是此前 serialize() 的结果（跨会话沉淀）。
// 返回全部方法（同步）。
export function createBlackboard({ initial } = {}) {
  const board = new Map();          // topic → [entry]
  const inboxes = new Map();        // agent → [message]
  const tasks = [];                 // [{ id, title, owner, status, note, at, doneAt }]
  let seq = 0;                      // 黑板条目序号（全局）
  let msgSeq = 0;                   // 消息序号（全局，便于 inbox 的 since）
  let taskSeq = 0;

  const seed = initial && typeof initial === 'object' ? initial : null;
  if (seed && seed.topics && typeof seed.topics === 'object') {
    for (const [topic, list] of Object.entries(seed.topics)) {
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
  if (seed && seed.messages && typeof seed.messages === 'object') {
    for (const list of Object.values(seed.messages)) {
      for (const raw of (Array.isArray(list) ? list : [])) {
        msgSeq += 1;
        const message = normalizeMessage(raw, msgSeq);
        if (!message) continue;
        const bucket = inboxes.get(message.to) || [];
        bucket.push(message);
        while (bucket.length > BLACKBOARD_MAX_MESSAGES) bucket.shift();
        inboxes.set(message.to, bucket);
      }
    }
  }
  if (seed && Array.isArray(seed.tasks)) {
    for (const raw of seed.tasks) {
      if (tasks.length >= TEAM_TASK_MAX) break;
      const title = String((raw && raw.title) || '').trim().slice(0, TEAM_TASK_TITLE_MAX);
      if (!title) continue;
      taskSeq += 1;
      tasks.push({
        id: Number(raw && raw.id) || taskSeq,
        title,
        owner: normalizeAgent(raw && raw.owner),
        status: TASK_STATUSES.includes(raw && raw.status) ? raw.status : 'open',
        note: String((raw && raw.note) || '').slice(0, BLACKBOARD_TEXT_MAX),
        at: Number(raw && raw.at) || Date.now(),
        doneAt: Number(raw && raw.doneAt) || 0,
      });
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
    // 直连消息：投递到某个同伴的收件箱（to 归一后作键）。
    send({ to, from, text } = {}) {
      const target = normalizeAgent(to);
      if (!target) return { ok: false, error: 'to 不能为空。' };
      const body = String(text == null ? '' : text).trim().slice(0, BLACKBOARD_TEXT_MAX);
      if (!body) return { ok: false, error: 'text 不能为空。' };
      msgSeq += 1;
      const bucket = inboxes.get(target) || [];
      bucket.push({ seq: msgSeq, to: target, from: String(from || '匿名').slice(0, 48), text: body, at: Date.now() });
      while (bucket.length > BLACKBOARD_MAX_MESSAGES) bucket.shift();
      inboxes.set(target, bucket);
      return { ok: true, to: target, seq: msgSeq, count: bucket.length };
    },
    inbox({ for: agent, since } = {}) {
      const target = normalizeAgent(agent);
      if (!target) return { ok: false, error: 'for 不能为空。', messages: [], latest: 0 };
      const bucket = inboxes.get(target) || [];
      const after = Number.isFinite(Number(since)) ? Number(since) : 0;
      const messages = bucket.filter(item => item.seq > after);
      const latest = bucket.length ? bucket[bucket.length - 1].seq : 0;
      return { ok: true, for: target, messages, latest };
    },
    // 任务看板：add / claim / complete / list。
    addTask({ title, owner } = {}) {
      const text = String(title == null ? '' : title).trim().slice(0, TEAM_TASK_TITLE_MAX);
      if (!text) return { ok: false, error: 'title 不能为空。' };
      if (tasks.length >= TEAM_TASK_MAX) return { ok: false, error: `任务数已达上限 ${TEAM_TASK_MAX}。` };
      taskSeq += 1;
      const task = { id: taskSeq, title: text, owner: normalizeAgent(owner), status: 'open', note: '', at: Date.now(), doneAt: 0 };
      tasks.push(task);
      return { ok: true, task: { ...task } };
    },
    claimTask({ id, by } = {}) {
      const task = tasks.find(item => item.id === Number(id));
      if (!task) return { ok: false, error: '任务不存在。' };
      if (task.status === 'done') return { ok: false, error: '任务已完成。' };
      task.owner = normalizeAgent(by) || task.owner;
      task.status = 'claimed';
      return { ok: true, task: { ...task } };
    },
    completeTask({ id, by, note } = {}) {
      const task = tasks.find(item => item.id === Number(id));
      if (!task) return { ok: false, error: '任务不存在。' };
      task.status = 'done';
      if (normalizeAgent(by)) task.owner = normalizeAgent(by);
      if (note) task.note = String(note).slice(0, BLACKBOARD_TEXT_MAX);
      task.doneAt = Date.now();
      return { ok: true, task: { ...task } };
    },
    listTasks() {
      return tasks.map(item => ({ ...item }));
    },
    size() {
      return board.size;
    },
    hasContent() {
      if (tasks.length) return true;
      for (const bucket of board.values()) if (bucket.length) return true;
      for (const bucket of inboxes.values()) if (bucket.length) return true;
      return false;
    },
    // 序列化成可落盘/可播种的纯对象（跨会话黑板文件用）。
    serialize() {
      const topics = {};
      for (const [topic, bucket] of board) {
        topics[topic] = bucket.map(item => ({ seq: item.seq, from: item.from, text: item.text, at: item.at }));
      }
      const messages = {};
      for (const [agent, bucket] of inboxes) {
        messages[agent] = bucket.map(item => ({ seq: item.seq, to: item.to, from: item.from, text: item.text, at: item.at }));
      }
      return {
        version: BLACKBOARD_VERSION,
        updatedAt: Date.now(),
        topics,
        messages,
        tasks: tasks.map(item => ({ ...item })),
      };
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

// 把收件箱结果格式化成模型可读文本。
export function formatInboxMessages(agent, messages) {
  const list = Array.isArray(messages) ? messages : [];
  if (list.length === 0) return `「${agent}」的收件箱暂无新消息。`;
  const lines = list.map(item => `[${item.seq}] ${item.from}：${item.text}`);
  const text = lines.join('\n');
  return text.length > BLACKBOARD_READ_MAX
    ? `${text.slice(0, BLACKBOARD_READ_MAX)}…（已截断，可用 since 读取更新的条目）`
    : text;
}

// 把任务看板格式化成模型可读文本。
export function formatTaskBoard(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  if (list.length === 0) return '任务看板为空。';
  return list.map(item => `#${item.id} [${item.status}] ${item.title}${item.owner ? `（@${item.owner}）` : ''}${item.note ? ` — ${item.note}` : ''}`).join('\n');
}

// 纯函数：把黑板归纳成展示用快照 [{ topic, messages }]（按主题名排序）。
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

// 纯函数：任务看板展示快照（GUI 用）。
export function boardTasks(board) {
  if (!board || typeof board.listTasks !== 'function') return [];
  return board.listTasks();
}

// 团队协作时追加到子代理系统提示的说明（无黑板时调用方不追加）。
export function boardPromptSuffix() {
  return '\n【团队通信】你和其它分身共享一块黑板 + 一条消息总线 + 一张任务看板：'
    + '用 board_post({topic, text}) 把进展/发现/中间结论发布到某个主题下，用 board_read({topic}) 读取同伴写的内容；'
    + '只想告诉某个同伴时用 board_send({to, text})，对方用 board_inbox({for}) 收；'
    + '分工用 board_task({action:"add"|"claim"|"complete"|"list", ...}) 在共享任务看板上认领与完成。'
    + '黑板可能已有此前会话沉淀的内容——开始前先 board_read 你关心的主题，避免重复劳动。';
}
