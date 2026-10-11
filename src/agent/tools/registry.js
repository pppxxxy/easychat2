// Agent 工具注册表与运行器。
//
// 纯 JS、零原生依赖，便于 Node 单测。工具按工作区模式门控：
//   ask（询问）   —— 不暴露任何工具
//   read（只读）  —— 仅 readOnly 工具
//   write（可改） —— 全部工具
//
// 另有一类「聊天内工具」（chatTool: true）：它们是受控白名单（目前只有联网搜索），
// 与工作区模式无关——聊天页默认就是 ask，如果照搬上表它们将永远不可用。
// 门控改为独立的 allowChatTools 开关，由聊天路径按用户设置显式打开；
// 两条门控互不影响：ask 模式下工作区工具依旧一律不放行。

import { tActive } from '../../i18n/index.js';

export const AGENT_MODES = Object.freeze({
  ASK: 'ask',
  READ: 'read',
  WRITE: 'write',
});

const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const DEFAULT_TOOL_TIMEOUT_MS = 15000;

// 超时分级表（G2 审计口径，2026-10-10）：这是**策略**，不是实现细节——工具超时给多少，
// 取决于「超时之后模型该怎么办」，所以与超时文案是一体两面，放一起便于对照审计。
//  · 纯读类（列表/读取）：维持默认 15s。读不到重读一次，代价低。
//  · 写副作用类（写文件 / 命令执行 / 跑代码 / 触发构建 / 推送）：60–120s。
//  · 长任务（子代理多轮迭代）：300s。
// 通则：**工具层超时必须大于执行器自身的兜底**——shell/python 有原生看门狗（各 30s，
// 到点强杀进程）。让执行器先动手，模型收到的才是「执行器已强制终止」这条真话；
// 反过来工具层先放弃，会把「其实已经停了」说成「结果未知」。
export const TOOL_TIMEOUT_TIERS = Object.freeze({
  READ: DEFAULT_TOOL_TIMEOUT_MS,
  WRITE_MIN: 60000,
  WRITE_MAX: 120000,
  LONG: 300000,
});
export const DEFAULT_TOOL_TIMEOUT = DEFAULT_TOOL_TIMEOUT_MS;

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
    // 聊天内受控工具（联网搜索）：不受工作区模式门控，由 allowChatTools 单独放行。
    chatTool: source.chatTool === true,
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
// chatTool 走独立通道：调用方必须显式传 allowChatTools 才放行（见文件头说明）。
export function canRunTool(tool, mode, options = {}) {
  if (!tool) return false;
  if (tool.chatTool === true) return options.allowChatTools === true;
  const resolved = mode || AGENT_MODES.ASK;
  if (resolved === AGENT_MODES.WRITE) return true;
  if (resolved === AGENT_MODES.READ) return tool.readOnly === true;
  return false;
}

// 暴露层：按模式生成发往模型的 tool 定义。
// 聊天内工具只有在 allowChatTools 时才一并列出——不列出模型就不会调用，
// 这是「不暴露即不可达」的第一层。
export function listToolsForMode(mode, options = {}) {
  return listRegisteredTools()
    .filter(tool => canRunTool(tool, mode, options))
    .map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
}

// D4-1：结果出口钩子——宿主注入（工作区宿主读 hooks.json 的 on_tool_result 条目，
// 按工具名匹配后往结果尾部追加提醒）。三条纪律：
// 1. 只对**成功**结果生效——错误结果不该被「增强」成看起来成功的样子；
// 2. 钩子自身抛错按原结果返回——增强是增值步骤，不能把工具执行本身毁掉；
// 3. 不注入 = 不调用，行为与旧版逐字节一致。
async function applyResultHook(ctx, name, args, result) {
  if (!result || result.isError === true) return result;
  if (typeof ctx.onToolResult !== 'function') return result;
  try {
    const patched = await ctx.onToolResult({ name, args }, result);
    if (patched && typeof patched.content === 'string') {
      return { content: patched.content, isError: patched.isError === true };
    }
  } catch (error) {}
  return result;
}

export async function runTool(call, ctx = {}) {
  const name = String((call && call.name) || '').trim();
  const tool = registry.get(name);
  if (!tool) return toErrorResult(`未知工具：${name || '(空)'}`);
  if (!canRunTool(tool, ctx.mode, { allowChatTools: ctx.allowChatTools === true })) {
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
  // G2（2026-10-10）：超时**不是「失败」**——JS 侧停不掉已经发出去的 promise，
  // 工具可能已经生效（写了文件、发了请求、改了远端）。文案必须说「结果未知」并给
  // 下一步指引；**禁止**暗示「没执行 / 已失败」——模型看到「失败」会直接重试，
  // 对写操作就是重复副作用（同一笔操作做两次）。
  const timeoutSeconds = Math.max(1, Math.round(tool.timeoutMs / 1000));
  const timeoutReason = `工具 ${name} 执行超过 ${timeoutSeconds} 秒，已放弃等待——结果未知：操作可能已经生效。`
    + '先用只读工具确认实际状态，再决定是否重试；不要盲目重跑写操作。';
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
        // 透传宿主审批钩子：需要「工具内部再审批」（如可写子代理的逐写确认）的工具有出口。
        // 缺失时工具必须按「不可询问 = 拒绝」处理（与上面 requiresConfirmation 同款纪律）。
        confirm: typeof ctx.confirm === 'function' ? ctx.confirm : null,
        // 透传「问用户」钩子：ask_user 工具经它提选择题（缺失时工具按「问不到 = 不执行」）。
        ask: typeof ctx.ask === 'function' ? ctx.ask : null,
      })),
      timeoutPromise,
      abortPromise,
    ]);
    if (isAbortError(result)) throw result;
    if (result && typeof result === 'object' && typeof result.content === 'string') {
      return applyResultHook(ctx, name, args, { content: result.content, isError: result.isError === true });
    }
    return applyResultHook(ctx, name, args, {
      content: typeof result === 'string' ? result : String(result === undefined || result === null ? '' : result),
      isError: false,
    });
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