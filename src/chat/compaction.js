// D3 轻量 Compaction：会话长到快撑爆 AsyncStorage（6MB 级）时的软着陆。
//
// 做法：一次模型调用把历史压成三段——已完成 / 关键决策与发现 / 未完成与下一步；
// 成功后用「一条摘要消息 + 最近 K 条原文」替换旧消息数组。纯函数与模型调用分层
// （调用在 ChatScreen），Node 直测。
//
// 为什么保留最近 K 条原文：摘要会丢细节，最近几轮是当前任务的「工作台」；
// 全替换成一段摘要会让模型立刻失去正在进行的上下文。
//
// 与分支系统：fork 点用消息 id 引用，压缩会让引用旧消息的分支失效——分支树
// （branchTree）对找不到的 fork 点已有 `stale` 降级，不会崩；用户可在分支列表
// 里自行清理（登记说明）。
//
// 本模块不 import i18n：它产出的文本是**发给模型的提示词**与**带标记的摘要
// 消息**（会话内容，不是界面文案）——铁律照旧。

export const COMPACTION_THRESHOLD_BYTES = 4 * 1024 * 1024;
export const COMPACTION_KEEP_RECENT = 6;
export const COMPACTION_MIN_MESSAGES = 8;
export const COMPACTION_MARKER = '[历史压缩]';
// 压缩请求本身也不能爆：逐条截断 + 总量上限（超限丢最旧的——信息密度最低）。
export const COMPACTION_PER_MESSAGE_MAX = 800;
export const COMPACTION_TRANSCRIPT_MAX = 60000;

const COMPACTION_SYSTEM_PROMPT = [
  '你是对话压缩器。把下面的对话历史压成三段中文摘要：',
  '1. 已完成：已经做完、已经确认的事（保留具体结论与数字）；',
  '2. 关键决策与发现：做过的选择及原因、发现的重要事实（保留名称、路径、参数）；',
  '3. 未完成与下一步：还没做的事、待确认的问题、接下来的计划。',
  '要求：只输出这三段摘要本身（分别以「已完成：」「关键决策与发现：」「未完成与下一步：」开头），',
  '不要寒暄、不要评论、不要复述全部内容；总长控制在原文的 10% 以内。',
].join('\n');

// 序列化体积（与 AsyncStorage 落盘同口径的字符数近似）。
export function estimateMessagesBytes(messages) {
  try {
    return JSON.stringify(Array.isArray(messages) ? messages : []).length;
  } catch (error) {
    return 0;
  }
}

// 人类可读体积（设置页显示；MB/KB 是通用记法，不走 i18n）。
export function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)}MB`;
  if (value >= 1024) return `${Math.round(value / 1024)}KB`;
  return `${value}B`;
}

export function shouldCompact(messages, threshold = COMPACTION_THRESHOLD_BYTES) {
  return estimateMessagesBytes(messages) > threshold;
}

// 消息 → 一行转写（聊天页消息用 text 字段；空内容跳过）。
function messageLine(item) {
  const role = item && item.role === 'user' ? '用户' : '助手';
  const text = String((item && (item.text || item.content)) || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const clipped = text.length > COMPACTION_PER_MESSAGE_MAX
    ? `${text.slice(0, COMPACTION_PER_MESSAGE_MAX)}…`
    : text;
  return `${role}：${clipped}`;
}

// 构造压缩请求：system 指示三段式 + user 塞转写后的对话。
// **总长超限时丢最旧的**（从最新往前装，装不下的旧消息不塞）——最近的细节
// 对摘要质量更重要，且旧消息本来就信息密度低。
export function buildCompactionSummaryRequest(messages) {
  const lines = (Array.isArray(messages) ? messages : [])
    .filter(item => item && (item.role === 'user' || item.role === 'assistant'))
    .map(messageLine)
    .filter(Boolean);
  const kept = [];
  let total = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (total + line.length > COMPACTION_TRANSCRIPT_MAX) break;
    kept.unshift(line);
    total += line.length + 1;
  }
  return [
    { role: 'system', content: COMPACTION_SYSTEM_PROMPT },
    { role: 'user', content: kept.join('\n') },
  ];
}

// 解析模型输出：trim；空 → ''（调用方据此判失败，保持原会话不动）。
export function parseCompactionSummary(text) {
  return String(text == null ? '' : text).trim();
}

// 替换：摘要消息（带 marker——模型下一轮能看出这是压缩产物）+ 最近 K 条原文。
export function applyCompaction(messages, summary, recentCount = COMPACTION_KEEP_RECENT) {
  const list = Array.isArray(messages) ? messages : [];
  const keep = Math.max(0, Math.floor(Number(recentCount) || 0));
  const meaningful = list.filter(item => item
    && (item.role === 'user' || item.role === 'assistant')
    && String((item && (item.text || item.content)) || '').trim());
  const recent = keep > 0 ? meaningful.slice(-keep) : [];
  const summaryMessage = {
    id: `compaction-${Date.now()}`,
    role: 'assistant',
    text: `${COMPACTION_MARKER}\n${String(summary == null ? '' : summary).trim()}`,
    at: Date.now(),
  };
  return [summaryMessage, ...recent];
}

// 设置页展示用：{ bytes, sizeText, due, threshold }。
export function compactionStatus(messages, threshold = COMPACTION_THRESHOLD_BYTES) {
  const bytes = estimateMessagesBytes(messages);
  return { bytes, sizeText: formatBytes(bytes), due: bytes > threshold, threshold };
}
