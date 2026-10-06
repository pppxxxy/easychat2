// 工具定义与 tool_choice 在各协议下的转换。纯函数。

export function normalizeTools(tools) {
  return (Array.isArray(tools) ? tools : [])
    .map(tool => ({
      name: String((tool && tool.function && tool.function.name) || (tool && tool.name) || ''),
      description: String((tool && tool.function && tool.function.description) || (tool && tool.description) || ''),
      parameters: (tool && tool.function && tool.function.parameters)
        || (tool && tool.parameters)
        || { type: 'object', properties: {} },
    }))
    .filter(tool => tool.name);
}

export function buildAnthropicTools(tools) {
  return normalizeTools(tools).map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }));
}

export function buildResponsesTools(tools) {
  return normalizeTools(tools).map(tool => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

export function buildAnthropicToolChoice(toolChoice) {
  if (toolChoice === undefined || toolChoice === null || toolChoice === 'auto') return { type: 'auto' };
  if (toolChoice === 'none') return undefined;
  if (toolChoice === 'required') return { type: 'any' };
  if (typeof toolChoice === 'string') return { type: 'tool', name: toolChoice };
  if (toolChoice && toolChoice.type === 'function' && toolChoice.function) {
    return { type: 'tool', name: String(toolChoice.function.name || '') };
  }
  return { type: 'auto' };
}

export function buildResponsesToolChoice(toolChoice) {
  if (toolChoice === undefined || toolChoice === null || toolChoice === 'auto') return 'auto';
  if (toolChoice === 'none') return 'none';
  if (toolChoice === 'required') return 'required';
  if (typeof toolChoice === 'string') return { type: 'function', name: toolChoice };
  if (toolChoice && toolChoice.type === 'function' && toolChoice.function) {
    return { type: 'function', name: String(toolChoice.function.name || '') };
  }
  return 'auto';
}
