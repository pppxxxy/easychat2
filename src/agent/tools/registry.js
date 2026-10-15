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

import { evaluatePermissionRules } from '../permissions.js';
import { tActive } from '../../i18n/index.js';
import { confirmSignature, repeatGuardMessage } from './confirmBudget.js';

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

// requiresConfirmation 归一：true / 函数原样保留，其余（含 truthy 非布尔）→ false。
// 函数形态让「同一工具按参数分级确认」成为注册表的一等能力（见 control_music）。
function normalizeRequiresConfirmation(value) {
  if (value === true) return true;
  return typeof value === 'function' ? value : false;
}

/**
 * 求值「这次调用是否需要用户确认」——**函数形态的唯一入口**。
 *
 * 为什么必须导出而不是各处自己写 `=== true`：`requiresConfirmation` 现在可能是函数
 * （按 args 分级，见 control_music）。任何写成 `definition.requiresConfirmation === true`
 * 的消费方，对函数形态都会求值为 **false** ——那是**放行**方向，属 fail-open。
 * 已核实的两个消费方（mcp/serverRuntime.js 的 confirm 钩子、agent/subagent.js 的
 * needsConfirm）原先正是这种写法；合并 m1015m1 时统一改走本函数。
 *
 * 判据与 runTool 内部**逐字一致**（同一个求值，不是两份）：`=== true` 才为真，
 * 函数形态按 args 求值后同样只认 `=== true`（返回值非布尔的实现按「不确认」处理，
 * 与 normalize 的严格口径同源）。
 *
 * @param {object} tool 注册表里的工具定义（或任意带该字段的对象）
 * @param {object} [args] 本次调用参数（函数形态按它分级）
 */
export function requiresConfirmationFor(tool, args = {}) {
  const value = tool && tool.requiresConfirmation;
  if (typeof value === 'function') {
    try {
      return value(args) === true;
    } catch (error) {
      // 判定函数抛错：按**需要确认**处理（fail-closed）。
      // 分级函数的用途是「少打扰用户」，它坏掉时宁可多问一次，也不能静默放行。
      return true;
    }
  }
  return value === true;
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
    // 需要用户逐次点头的工具（run_shell 等）。缺省 false，故既有工具行为不变。
    // 也接受**函数**：`(args) => boolean`，用于「同一工具里按参数分级」的场景
    //（FEAT-AC2 的 control_music：play/resume 要确认、pause/next 不弹）——
    // 整工具级布尔会把不弹的动作也变成要确认，违背产品裁决。
    requiresConfirmation: normalizeRequiresConfirmation(source.requiresConfirmation),
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
      // 这里**只挑 content/isError**（不搬运 noticeKey/noticeParams），三条理由：
      //
      // ⚠️ 先看这里（省一趟白跑）：**真正的钩子实现在宿主侧，不在 workspace/hooks.js**。
      //    hooks.js 只把 hooks.json 解析成结构、按工具名产出 message 列表
      //    （collectToolResultNotices），它**不碰工具结果**；真正改写 content 的是
      //    workspace/screen/ChatPanel.js:1321-1333 —— `content: `${result.content}\n\n
      //    [工作区钩子] ${notices.join('；')}``。排查「结果被谁改了」要往那里去。
      //
      // 1. 钩子是「追加」语义，不是「替换」。宿主实现见 workspace/screen/ChatPanel.js:1321：
      //    `content: `${result.content}\n\n[工作区钩子] ${notices.join('；')}``——它把提醒**接在
      //    正文尾部**，返回的 content 是「原正文 + 提醒」的并集，不是另一句话。
      // 2. 因此 noticeKey 若继续传下去，展示层会**把钩子追加的正文藏起来**：conversation.js 的
      //    toolNoticeText 取到词条后，ToolCallRow.js:151-153 是 `notice || resultText` 的**整段
      //    替换**（预览与完整输出都换）。用户自己配的 on_tool_result 提醒就此消失——那比「正文
      //    读回中文」更糟：词条只是同一句话的语言问题，钩子提醒是用户明确要求他看到的内容。
      // 3. 而且**光在这里透传也传不出去**：宿主钩子（ChatPanel.js:1326）自己就只回
      //    `{ content, isError }`，noticeKey/noticeParams 在钩子那一跳已经丢了。要真的两头都显示，
      //    必须同时改 ChatPanel（钩子转发 notice）+ ToolCallRow（词条与正文各显示一段），
      //    两处都不在本批所有权内 ⇒ 本批**只报告、不改**，避免为修一个不可达分支引入新风险。
      //
      // ⚠️ 今天这个分支**不可达**（不是 bug，别当 bug 修）：带 noticeKey 的结果只有三条
      //    ——gitTools.js 的 gitNoRepo、subagentTool.js 的 subagentWriteBlocked、
      //    workflowTool.js 的 workflowWriteBlocked——它们**全是 `isError: true`**，
      //    而本函数第 137 行对错误结果直接原样返回（错误结果不该被「增强」成看起来成功）。
      //    将来若出现「成功结果 + noticeKey」且用户配了 on_tool_result，就会走到这里并丢掉
      //    notice：展示层回落中文正文，**钩子追加的提醒仍然可见**——即上面第 2 条的取舍兑现，
      //    属已知取舍。tests/toolRegistry.test.mjs 把这个取舍钉成了锚点。
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

  // 权限规则求值（P1，2026-10-11）：`deny` 必须对**任意工具**生效，不只对
  // `requiresConfirmation` 的那些。
  //
  // 事故形态：此前钩子规则的唯一入口是 `onToolApproval`（宿主接的 confirm），而
  // runTool 只在 `tool.requiresConfirmation` 时才调 confirm —— 于是写在
  // `write_workspace_file` / `edit_workspace_file` 上的 before_tool deny **永不求值**
  // （这些工具按设计不逐条确认，见 paths.js 的说明），与 hooks.js「拦下任意工具」矛盾。
  //
  // 求值时机放在审批之前：deny 是「绝不执行」，连问都不该问；ask 则并进下面的
  // needsConfirm，与 requiresConfirmation 走同一条审批链（没有 confirm 出口 = 拒绝）。
  //
  // ctx.permissionRules 允许是**函数**（每次调用时取，宿主据此读到最新的 hooks.json）；
  // 也接受现成数组。函数**可以是 async**（宿主的读盘实现就是 async）—— 所以必须 await。
  //
  // ⚠️ P0-0（2026-10-12）：**这里漏了 await，导致上面那整段修复从未生效。**
  // 宿主接的是 `readHookPermissionRules`（workspace/hooks.js 是 `async function`），
  // 不 await 拿到的是 Promise；`Array.isArray(Promise)` 恒为 false ⇒ if 分支永不进入
  // ⇒ `ruleVerdict` 恒为 null ⇒ **钩子规则在 runTool 里被静默丢弃**。
  // 实测：`Array.isArray((async () => [rule])()) === false`。
  // 为什么测试全绿：用例传的是**同步数组**，而生产传的是 **async 函数** —— 形状不一致的缺口。
  // 修法：await 之后再判数组；读失败仍按「没有规则」处理（下面的 catch 语义不变）——
  // 规则读失败不能变成静默放行，但也不能把工具链整体打挂（审批与 requiresConfirmation 仍在）。
  // ∴ 两线合并取 D 线版本（main 侧没记下「那次修复曾经从未生效」这件事）。
  let ruleVerdict = null;
  try {
    const rawRules = typeof ctx.permissionRules === 'function'
      ? await ctx.permissionRules()
      : ctx.permissionRules;
    if (Array.isArray(rawRules) && rawRules.length > 0) {
      ruleVerdict = evaluatePermissionRules(rawRules, { tool: tool.name, args });
    }
  } catch (error) {
    ruleVerdict = null;
  }
  if (ruleVerdict === 'deny') {
    return toErrorResult(`该操作被工作区钩子的 before_tool 规则拦下（未执行）：${name}`);
  }

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
  //
  // 命中 ask 规则的工具即使没声明 requiresConfirmation 也要问（ask 档的意义就是从
  // 宽规则里挖出例外），批准只对这一次生效（askOnly，由宿主侧 approveToolCall 保证）。
  //
  // `requiresConfirmation` 可能是**函数**（按 args 分级）：只有 play/resume 要确认时，
  // 这里为 pause/next 求值为 false，不会打扰用户（产品裁决的唯一事实源在工具纯层）。
  // 求值收口在 requiresConfirmationFor —— 与宿主侧消费方共用**同一个**判定，
  // 不在这里再写一遍 `=== true` 的三目（两处各写一份必然漂移）。
  const needsConfirmation = requiresConfirmationFor(tool, args);
  if (needsConfirmation || ruleVerdict === 'ask') {
    if (typeof ctx.confirm !== 'function') {
      return toErrorResult(`该操作需要用户确认，但当前环境无法询问用户（未执行）：${name}`);
    }
    // FEAT-AC8 P0-B：**同签名确认预算**（防「连环弹卡」烧用户）。
    //
    // 事故：一个回合弹了 5 张卡（4 允许 + 1 拒绝）——工具持续失败（BUG-A）时模型
    // 合规重发，每次重发都要用户再点一次。重复调用检测只 nudge 不阻断，拦不住这件打扰。
    // 预算用尽 → **按拒绝结算**（方向是拒绝，不是放行），并给模型一句明确的收尾话术，
    // 否则它只看到「用户拒绝」会继续重发。
    //
    // 预算实例由**回合**持有（loop.js 每回合建一个并经 ctx 传下来），
    // 不是模块级单例——那样会把「上一轮用户已经点过」错算进新一轮，
    // 且并发回合（工作区 + 悬浮窗）会互相吃预算。
    const budget = ctx.confirmBudget && typeof ctx.confirmBudget.shouldAsk === 'function'
      ? ctx.confirmBudget
      : null;
    if (budget && !budget.shouldAsk(confirmSignature(tool.name, args))) {
      return toErrorResult(repeatGuardMessage(tool.name, { budget: budget.budget }));
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
        // AS2：confirm_flow 的多题确认钩子与宿主选项源（角色列表等长清单由宿主注入，
        // agent 只写 source 名——防模型编造角色 id）。缺失时工具按「问不到 = 不执行」拒绝。
        confirmFlow: typeof ctx.confirmFlow === 'function' ? ctx.confirmFlow : null,
        choices: typeof ctx.choices === 'function' ? ctx.choices : null,
      })),
      timeoutPromise,
      abortPromise,
    ]);
    if (isAbortError(result)) throw result;
    if (result && typeof result === 'object' && typeof result.content === 'string') {
      // noticeKey/noticeParams（toolDefs/toolNotices.js）：content 是给模型读的中文正文，
      // 这两个字段是**同一句话的界面侧词条引用**，给展示层按当前语言渲染用。
      // 必须与 isError 同款**显式搬运**——这里是从工具结果到展示层的第 1 跳，只挑字段，
      // 漏一个整条链就断在源头（英文界面继续显示中文正文）。
      // 缺失时不造 undefined 键：老工具/老形态保持「无该字段」，展示层据此回落中文正文
      //（见 workspace/conversation.js 的 toolRowsFromTrace 与 screen/ToolCallRow.js）。
      return applyResultHook(ctx, name, args, {
        content: result.content,
        isError: result.isError === true,
        ...(result.noticeKey === undefined ? {} : { noticeKey: result.noticeKey }),
        ...(result.noticeParams === undefined ? {} : { noticeParams: result.noticeParams }),
      });
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