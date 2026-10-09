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

export function serializeToolResult(result, limit = TOOL_RESULT_LIMIT) {
  const content = typeof result === 'string'
    ? result
    : String((result && result.content) || '');
  if (content.length <= limit) return content;
  // 截断句要能指导下一步（A2）：告诉模型原长与「怎么拿到更多」——文件读取有
  // offset 续读（工具侧实现），命令/MCP 输出可以收窄后重跑。通用层不感知
  // 具体工具语义，只给这两条通路。
  return `${content.slice(0, limit)}…（已截断：原长 ${content.length} 字符；文件读取可用 offset 续读，命令输出可收窄后重跑）`;
}
