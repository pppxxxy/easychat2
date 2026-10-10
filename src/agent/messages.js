// Agent 消息适配（主循环与子代理共用，纯函数零依赖）。
//
// 从 loop.js 抽出来的两件套：
// - toAssistantMessage：把模型返回（text + toolCalls）整理成 history 里的 assistant 消息；
// - serializeToolResult：把工具结果整理成 tool 消息文本（带上限截断）。
// 单独成文件的原因：子代理循环与主循环必须对「同一种模型返回」做同一种翻译——
// 两处抄两份，出现分歧时表现是「子代理和主代理行为微妙不同」，极难排查。

export const TOOL_RESULT_LIMIT = 16 * 1024;

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
