// Agent 工具注册表与运行器。
//
// 纯 JS、零原生依赖，便于 Node 单测。工具按工作区模式门控：
//   ask（询问）   —— 不暴露任何工具
//   read（只读）  —— 仅 readOnly 工具
//   write（可改） —— 全部工具

export const AGENT_MODES = Object.freeze({
  ASK: 'ask',
  READ: 'read',
  WRITE: 'write',
});

const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const DEFAULT_TOOL_TIMEOUT_MS = 15000;

const registry = new Map();

function makeAbortError() {
  const error = new Error('已停止生成。');
  error.name = 'AbortError';
  error.canceled = true;
  return error;
}

function isAbortError(error) {
  return !!error && (error.canceled === true || error.name === 'AbortError');
}

function toErrorResult(message) {
  return { content: String(message || '工具执行失败。'), isError: true };
}

export function registerTool(definition) {
  const source = definition && typeof definition === 'object' ? definition : {};
  const name = String(source.name || '').trim();
  if (!TOOL_NAME_PATTERN.test(name)) {
    throw new Error(`工具名非法：${name || '(空)'}`);
  }
  if (typeof source.execute !== 'function') {
    throw new Error(`工具 ${name} 缺少 execute 函数`);
  }
  const parameters = source.parameters && typeof source.parameters === 'object'
    ? source.parameters
    : { type: 'object', properties: {} };
  const normalized = {
    name,
    description: String(source.description || ''),
    parameters,
    readOnly: source.readOnly === true,
    execute: source.execute,
    timeoutMs: Number.isFinite(source.timeoutMs) && source.timeoutMs > 0
      ? source.timeoutMs
      : DEFAULT_TOOL_TIMEOUT_MS,
  };
  registry.set(name, normalized);
  return normalized;
}

export function unregisterTool(name) {
  return registry.delete(String(name || ''));
}

export function clearTools() {
  registry.clear();
}

export function getTool(name) {
  return registry.get(String(name || '')) || null;
}

export function listRegisteredTools() {
  return Array.from(registry.values());
}

// 执行层门控：与暴露层（listToolsForMode）一致，防越权双保险。
export function canRunTool(tool, mode) {
  if (!tool) return false;
  const resolved = mode || AGENT_MODES.ASK;
  if (resolved === AGENT_MODES.WRITE) return true;
  if (resolved === AGENT_MODES.READ) return tool.readOnly === true;
  return false;
}

// 暴露层：按模式生成发往模型的 tool 定义。
export function listToolsForMode(mode) {
  return listRegisteredTools()
    .filter(tool => canRunTool(tool, mode))
    .map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
}

export async function runTool(call, ctx = {}) {
  const name = String((call && call.name) || '').trim();
  const tool = registry.get(name);
  if (!tool) return toErrorResult(`未知工具：${name || '(空)'}`);
  if (!canRunTool(tool, ctx.mode)) {
    return toErrorResult(`当前模式不允许调用工具：${name}`);
  }

  let args;
  try {
    const raw = call && call.arguments;
    if (raw === undefined || raw === null || raw === '') args = {};
    else if (typeof raw === 'string') args = JSON.parse(raw);
    else args = raw;
  } catch (error) {
    return toErrorResult(`工具参数不是合法 JSON：${name}`);
  }

  const signal = ctx.signal || null;
  let timer = null;
  let onAbort = null;
  const timeoutReason = `工具执行超时（${tool.timeoutMs}ms）：${name}`;
  const timeoutPromise = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutReason)), tool.timeoutMs);
  });
  const abortPromise = new Promise((resolve, reject) => {
    if (!signal) return;
    if (signal.aborted) {
      reject(makeAbortError());
      return;
    }
    if (typeof signal.addEventListener === 'function') {
      onAbort = () => reject(makeAbortError());
      signal.addEventListener('abort', onAbort);
    }
  });

  try {
    if (signal && signal.aborted) throw makeAbortError();
    const result = await Promise.race([
      Promise.resolve().then(() => tool.execute(args, {
        signal,
        characterId: ctx.characterId,
        sessionId: ctx.sessionId,
        workspaceMode: ctx.mode,
      })),
      timeoutPromise,
      abortPromise,
    ]);
    if (isAbortError(result)) throw result;
    if (result && typeof result === 'object' && typeof result.content === 'string') {
      return { content: result.content, isError: result.isError === true };
    }
    return {
      content: typeof result === 'string' ? result : String(result === undefined || result === null ? '' : result),
      isError: false,
    };
  } catch (error) {
    if (isAbortError(error)) throw error;
    if (error && error.message === timeoutReason) return toErrorResult(timeoutReason);
    return toErrorResult(error && error.message ? error.message : `工具执行失败：${name}`);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort && signal && typeof signal.removeEventListener === 'function') {
      signal.removeEventListener('abort', onAbort);
    }
  }
}