// Agent 工具注册表与运行器。
//
// 纯 JS、零原生依赖，便于 Node 单测。工具按工作区模式门控：
//   ask（询问）   —— 不暴露任何工具
//   read（只读）  —— 仅 readOnly 工具
//   write（可改） —— 全部工具

import { tActive } from '../../i18n/index.js';

export const AGENT_MODES = Object.freeze({
  ASK: 'ask',
  READ: 'read',
  WRITE: 'write',
});

const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const DEFAULT_TOOL_TIMEOUT_MS = 15000;

const registry = new Map();

function makeAbortError() {
  const error = new Error(tActive('error.agent.generationStopped'));
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
    throw new Error(tActive('error.agent.toolNameInvalid', { name: name || '(空)' }));
  }
  if (typeof source.execute !== 'function') {
    throw new Error(tActive('error.agent.toolMissingExecute', { name }));
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
    // 需要用户逐次点头的工具（目前只有 run_shell）。缺省 false，故既有工具行为不变。
    requiresConfirmation: source.requiresConfirmation === true,
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

  // 人工审批必须在超时竞速**之外**：这里的等待时长取决于用户什么时候点按钮，
  // 几秒到几十秒都正常。若放进下面那个 15s 竞速里，用户多犹豫一下就变成
  // 「工具执行超时」，而工具其实一次都没跑。
  //
  // 拒绝与中止的语义都是「绝不执行」：返回错误结果让模型知道没执行，
  // 而不是抛异常中断整轮对话（中止信号才抛，那由上层处理）。
  //
  // **没有审批钩子 = 拒绝**，不是放行：需要确认的工具只可能在能问到用户的
  // 界面里执行。漏传 confirm（例如别处新起的 agent 循环）时应当是「跑不了」，
  // 绝不能变成「不用问就跑」。
  if (tool.requiresConfirmation) {
    if (typeof ctx.confirm !== 'function') {
      return toErrorResult(`工具需要用户确认，但当前环境无法询问用户（未执行）：${name}`);
    }
    if (signal && signal.aborted) throw makeAbortError();
    // 审批也要能被中止竞速：用户点「停止生成」时弹框可能还开着，弹框的按钮回调
    // 不会因为 abort 而触发，只 await confirm 会让循环卡在一个永远等不到答案的
    // Promise 上。用一个哨兵值做竞速，避免在 Promise 里 reject 造成未捕获拒绝。
    let onApprovalAbort = null;
    const abortSentinel = Symbol('abort');
    const approvalAbort = new Promise(resolve => {
      if (!signal || typeof signal.addEventListener !== 'function') return;
      onApprovalAbort = () => resolve(abortSentinel);
      signal.addEventListener('abort', onApprovalAbort);
    });
    let approved;
    try {
      approved = await Promise.race([
        Promise.resolve().then(() => ctx.confirm({ name: tool.name, args })),
        approvalAbort,
      ]);
    } catch (error) {
      // 审批钩子自身抛错（例如 UI 已卸载）：按中止处理，绝不默认放行。
      if (isAbortError(error) || (signal && signal.aborted)) throw makeAbortError();
      return toErrorResult(`工具确认失败（未执行）：${name}`);
    } finally {
      if (onApprovalAbort && signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onApprovalAbort);
      }
    }
    if (approved === abortSentinel || (signal && signal.aborted)) throw makeAbortError();
    if (!approved) return toErrorResult('用户拒绝了此操作（未执行）');
  }

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