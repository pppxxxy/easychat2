// Agent 消息适配（主循环与子代理共用，纯函数零依赖）。
//
// 从 loop.js 抽出来的两件套：
// - toAssistantMessage：把模型返回（text + toolCalls）整理成 history 里的 assistant 消息；
// - serializeToolResult：把工具结果整理成 tool 消息文本（带上限截断）。
// 单独成文件的原因：子代理循环与主循环必须对「同一种模型返回」做同一种翻译——
// 两处抄两份，出现分歧时表现是「子代理和主代理行为微妙不同」，极难排查。

export const TOOL_RESULT_LIMIT = 16 * 1024;

// ---------------------------------------------------------------------------
// P2-8：较早轮次的工具结果换成占位标记。
//
// 为什么在这里：本项目的工具结果**从不进持久化上下文**——`prompt/chatPipeline.js`
// 的 `buildHistory` 与 `chat/compaction.js` 的 `applyCompaction` 都只留
// user/assistant，聊天页的工具气泡是 `transient` 的 UI 临时消息。所以「压缩时丢弃
// 旧工具结果」在聊天页没有可丢的东西；真正吃窗口的是**同一个 turn 内的多轮工具
// 循环**：`loop.js` 把每轮的 `role:'tool'` 结果追加进本轮消息数组，之后每一轮请求
// 都要把它们重发一遍。
//
// 做法：**保留消息本身**，只把较早轮次的 `content` 换成占位标记。
// 为什么不能删消息：`role:'tool'` 必须与前面 assistant 的 `tool_calls` 一一配对，
// 少一条不是「信息少一点」而是「请求非法」，服务端直接拒。
// ---------------------------------------------------------------------------

// 占位标记同时承担「告知模型信息去哪了」——只说「已省略」会让模型以为内容还在别处，
// 它需要知道可以重新调用工具把信息取回来。
export const TOOL_RESULT_ELIDED = '[较早的工具结果已省略：为节省上下文，该结果的内容已被替换为占位标记。'
  + '如仍需其中的信息，请重新调用对应工具获取。]';
// 最近 N 轮的工具结果原样保留：模型正在据此推理的那几轮不动。
export const TOOL_RESULT_KEEP_ROUNDS = 2;
// 触发阈值：全部工具结果加起来不超过它时**什么都不做**——没有收益就不丢信息。
export const TOOL_RESULT_ELISION_BUDGET = 24 * 1024;

// 纯函数：返回新数组，不改入参数组、也不改任何消息对象（`messages` 往往是调用方
// 数组的浅拷贝，就地改对象会污染调用方的历史）。返回值带 `elided` / `savedChars`
// 供调用方与测试观测。
//
// 轮次边界由 `assistant.tool_calls` 划定：它后面的 `role:'tool'` 消息都属于这一轮。
export function elideOlderToolResults(messages, options = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const keepRounds = Number.isInteger(options.keepRounds) && options.keepRounds >= 0
    ? options.keepRounds
    : TOOL_RESULT_KEEP_ROUNDS;
  const budget = Number.isFinite(options.budget) && options.budget >= 0
    ? options.budget
    : TOOL_RESULT_ELISION_BUDGET;
  const mark = typeof options.mark === 'string' && options.mark ? options.mark : TOOL_RESULT_ELIDED;

  // 总量只算「还没被省略」的工具结果：已省略的若继续计入，它们会把总量一直顶在
  // 阈值之上，每轮都白跑一次全量替换（结果一样，但白费）。
  let totalChars = 0;
  const roundStarts = [];
  list.forEach((item, index) => {
    if (!item) return;
    if (item.role === 'tool' && typeof item.content === 'string' && item.content !== mark) {
      totalChars += item.content.length;
    }
    if (item.role === 'assistant' && Array.isArray(item.tool_calls) && item.tool_calls.length) {
      roundStarts.push(index);
    }
  });
  if (totalChars <= budget) return { messages: list, elided: 0, savedChars: 0, totalChars };

  // 只动「比最近 keepRounds 轮更早」的工具结果。轮数不够（roundStarts 不超过
  // keepRounds）→ boundary 为 0 → 一条都不动。
  const boundary = keepRounds <= 0
    ? list.length
    : (roundStarts.length > keepRounds ? roundStarts[roundStarts.length - keepRounds] : 0);

  let elided = 0;
  let savedChars = 0;
  const next = list.slice();
  for (let index = 0; index < boundary; index += 1) {
    const item = list[index];
    if (!item || item.role !== 'tool' || typeof item.content !== 'string') continue;
    // 只换「真的更省」的：比占位标记还短的结果换过去反而更长，不如不动。
    if (item.content.length <= mark.length) continue;
    savedChars += item.content.length - mark.length;
    next[index] = { ...item, content: mark };
    elided += 1;
  }
  if (elided === 0) return { messages: list, elided: 0, savedChars: 0, totalChars };
  return { messages: next, elided, savedChars, totalChars };
}

// text 为空且有 tool_calls 时 content 置 null：部分兼容端点拒绝空串 content。
export function toAssistantMessage(result) {
  const text = typeof (result && result.text) === 'string' ? result.text : '';
  const message = { role: 'assistant', content: text.length ? text : null };
  if (Array.isArray(result && result.toolCalls) && result.toolCalls.length) {
    message.tool_calls = result.toolCalls.map(call => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: call.arguments },
    }));
  }
  return message;
}

// UTF-16 代理对安全切点（D2）：index 落在高/低代理之间时回退一格——
// 半个 emoji 在界面/模型侧都是乱码，宁可少一个字符。只回退 1，不贪多。
function safeBoundary(text, index) {
  if (!Number.isFinite(index) || index <= 0) return 0;
  if (index >= text.length) return text.length;
  const prev = text.charCodeAt(index - 1);
  if (prev >= 0xd800 && prev <= 0xdbff) return index - 1;
  return index;
}

export function serializeToolResult(result, limit = TOOL_RESULT_LIMIT, toolName = '') {
  const content = typeof result === 'string'
    ? result
    : String((result && result.content) || '');
  if (content.length <= limit) return content;
  // D2 头尾保留：工具结果的两端信息密度最高——声明在头部、报错在尾部，中段
  // 省略（前 1/2 + 后 1/2，切点做代理对安全回退）。
  const headSize = Math.floor(limit / 2);
  const tailSize = limit - headSize;
  const headEnd = safeBoundary(content, headSize);
  const tailStart = safeBoundary(content, content.length - tailSize);
  const omitted = tailStart - headEnd;
  // 指引按工具名分派（D2）：有确切语义就不说通用话术（对计算类结果，「offset
  // 续读」是误导）。不认识的工具只做头尾保留，不写指引。
  let guidance = '';
  if (toolName === 'read_workspace_file') {
    // 参数名以工具定义为准（readTools.js）：offset + limit。历史上这里误写成
    // maxChars（那是 store 内部入参名），会把模型引向一个不存在的参数。
    guidance = '完整内容可用 read_workspace_file 的 offset/limit 分段精读。';
  } else if (toolName === 'search_workspace') {
    guidance = '可收窄 pattern、限定 subdir 或调小 contextLines 后重搜。';
  } else if (toolName === 'run_shell' || toolName === 'run_python') {
    guidance = '需要看中段可收窄命令/代码后重跑。';
  }
  return `${content.slice(0, headEnd)}\n…（中间省略 ${omitted} 字符，原始 ${content.length} 字符）…\n${content.slice(tailStart)}${guidance ? `\n（${guidance}）` : ''}`;
}
