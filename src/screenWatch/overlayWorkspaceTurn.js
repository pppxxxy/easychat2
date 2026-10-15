// FEAT-AC7 P0-A：悬浮窗**工作区回合**的执行器（从 useOverlayChatSend 外提）。
//
// 为什么要从页面里搬出来（本轮真正的根因）：悬浮窗的监听器此前全挂在
// **ScreenWatchScreen（角色版看屏幕页）的 useEffect 里**。用户在工作区页 / 其它页面 /
// app 退后台时那个组件不在栈顶 → 监听器根本不存在 → 原生 P0-D 修好的 EVENT_CHAT_SEND
// 发出来了，JS 侧没人接，静默丢弃（用户截图 #285：连发「？」都没人理）。
//
// 关键事实：**工作区 scope 这条链与任何页面都无关**——它只用到
// threads（存储）/ runWorkspaceWatchTurn / runHeadlessAgent / 工作区设置 / 确认桥，
// 全是进程级能力。所以它能（也应该）脱离页面生命周期独立跑。
// 聊天 scope 才需要页面的 generate（角色评论管线），那条走 ref 注入 + 兜底文案。
//
// 本文件不是 hook：app 级装配直接调用，页面不在场也能工作。

import { runWorkspaceWatchTurn } from './workspaceWatchTurn.js';
import { runHeadlessAgent } from '../workspace/headlessAgent.js';
import { appendThreadEntry, getOrCreateActiveThread, THREAD_SCOPE_WORKSPACE } from './threads.js';
import { pushOverlayChatMessage, setOverlayScopeMode, updateOverlayText } from './overlay.js';
import { createOverlayConfirmHandler } from './overlayConfirmBridge.js';
import { summarizeToolCall } from './overlaySummary.js';
import { createWorkspaceStore } from '../workspace/native.js';
import { readHookPermissionRules } from '../workspace/hooks.js';
import { readToolPermissionRules } from '../chat/toolApprovalFlow.js';
import { getWorkspaceSettings } from '../storage/workspace.js';
import { tActive } from '../i18n/index.js';
import { noteTurnEvent } from './turnDiagnostics.js';
import { notifyThreadsChanged } from './threadEvents.js';

// 进程级单例（确认钩子要在多轮之间复用；store 只为读 hooks.json）。
let store = null;
let confirmHandler = null;
// 串行化：同一时刻只跑一条回合（避免连点叠加请求）。app 级后它跨页面生效——
// 此前 busyRef 在 hook 里，页面切换会重置，连点能叠出两条并行回合。
let busy = false;

function ensureSingletons() {
  if (store === null) store = createWorkspaceStore({});
  // summarize：把工具调用渲染成人话摘要（AC1/AC2/AC4 的渲染函数经此接线）。
  //
  // ⚠️ 合并 m1015m1 时补上的一处**集成缺口**：那一批把 summarize 接进了
  // useOverlayChatSend（当时工作区回合还在那个 hook 里）；而 FEAT-AC7 已把
  // 工作区回合外提到本文件（app 级常驻，页面不在也能跑）。若不在此处一起接，
  // 工作区路径的确认卡会退回「工具名 + JSON args」——正是那批要修的毛病，
  // 且**只在悬浮窗工作区路径复现**（面板路径走 approveToolCall，不受影响）。
  // 两条路径现在共用同一个摘要实现，不会再各写一份而漂移。
  if (confirmHandler === null) confirmHandler = createOverlayConfirmHandler({ summarize: summarizeToolCall });
}

/** 测试/宿主可见：重置进程级状态（仅测试用）。 */
export function __resetOverlayWorkspaceTurn() {
  store = null;
  confirmHandler = null;
  busy = false;
}

/** 当前是否有一条工作区回合在跑（悬浮窗忙反馈与测试用）。 */
export function isOverlayWorkspaceBusy() {
  return busy;
}

/**
 * 跑一轮悬浮窗**工作区**回合。
 *
 * 返回 { ok, text, error }——**不抛**（调用方是原生事件回调，抛错只会变成未捕获拒绝）。
 * 收尾纪律（P0-C）：无论成功 / 失败 / 中止 / 超时，都把**用户消息 + 结论文案**落进线程，
 * 线程里永远不再出现「0 条目但对话存在」（用户截图 #288 的「（暂无内容）」）。
 *
 * @param {object} args
 * @param {string} args.text 用户说的话
 * @param {AbortSignal} [args.signal] 中止信号（页面「停止」按钮）
 */
export async function runOverlayWorkspaceTurn({ text = '', signal = null } = {}) {
  const said = String(text || '').trim();
  if (!said) return { ok: false, text: '', error: '' };
  if (busy) return { ok: false, text: '', error: '', skipped: 'busy' };
  busy = true;
  ensureSingletons();
  const startedAt = Date.now();
  try {
    const threadState = await getOrCreateActiveThread(
      'workspace',
      tActive('workspace.watch.assistantName'),
      Date.now(),
      THREAD_SCOPE_WORKSPACE
    ).catch(() => null);
    const thread = threadState ? threadState.thread : null;
    // 模式**跟随 app 工作区设置**（不再硬编码 read）。
    const workspaceSettings = await getWorkspaceSettings().catch(() => null);
    const workspaceMode = (workspaceSettings && workspaceSettings.mode) || 'ask';
    // 模式徽标（只读/可改）显示在标题行——用户要知道现在能不能改动。
    // 'ask' 档没有写工具，按只读显示（与 canRunTool 的实际放行一致）。
    setOverlayScopeMode(workspaceMode === 'write' ? 'write' : 'read').catch(() => {});
    // FEAT-AC8 P0-D：打点**收口在 runWorkspaceWatchTurn**（面板/悬浮窗同源，
    // 且真实轮数只有那一层看得全）。此前这里硬编码 round: 0（任务书指出的
    // 「round=0 是打点质量问题」——正确），现在只负责把落盘器注入进去。
    const result = await runWorkspaceWatchTurn({
      userText: said,
      thread,
      mode: workspaceMode,
      signal,
      runAgent: payload => runHeadlessAgent({
        ...payload,
        // 与 app 面板同源（ScreenWatchPanel 也这么传）——漏了它即便 mode=write，
        // headlessAgent 的 resolveHeadlessMode 仍可能把回合降级。
        allowWrite: workspaceMode === 'write',
      }),
      // 确认钩子：推**窗内卡片**并挂起等待（60s 超时按拒绝）。
      // 语义仍是 registry 的既定纪律「问不到用户 = 不执行」。
      confirm: confirmHandler,
      // 权限规则：与工作区聊天同一条合并入口。不接这条，写工具上的手写 deny
      // 在看屏幕会话里会变成死键（既有 P0-2 事故的同款形态）。
      permissionRules: async () => readToolPermissionRules(
        await readHookPermissionRules(store, 'workspace')
      ),
      appendEntry: appendThreadEntry,
      // 回合打点：走 turnDiagnostics 的注入式落盘器（app 级 bridge 里装好的）。
      // FEAT-AC9 P0-1/P0-2：这里是**裸焊**（曾把对象焊进两参签名 ⇒ 4 条 turn-unknown）。
      // 现在发射方统一两参；接收方也做了对象形态归一（双保险，未来新接线不再踩同一个坑）。
      onTurnEvent: noteTurnEvent,
      // P0-C：每条落库留痕（此前是裸 catch 静默吞错——真机上「写没写进去」无法分辨）。
      onThreadAppend: info => noteTurnEvent('thread-append', info),
      t: tActive,
    });
    // P0-C：回合结束后**通知面板刷新**（面板在场即刷新，不再等下次挂载）。
    // 成功路径不必再打 turn-done：那已在 runWorkspaceWatchTurn 里带着**真实轮数**发出。
    notifyThreadsChanged();
    return result;
  } catch (error) {
    const elapsed = Date.now() - startedAt;
    // FEAT-AC9 P0-3：这里捕获的是**回合开始前的准备失败**（取线程 / 读工作区设置），
    // 从来不是超时。原先错标 turn-timeout ⇒ 日志会把「线程存储读失败」说成
    // 「模型没响应」，把人朝错误方向带。runWorkspaceWatchTurn 自身不抛
    //（它内部已按 aborted/timeout/failed 如实收尾），故此处不会与它的收尾重复计入。
    noteTurnEvent('turn-failed', { elapsed, error });
    notifyThreadsChanged();
    return {
      ok: false,
      text: '',
      error: String((error && error.message) || '').trim() || tActive('screenWatch.comments.failed'),
    };
  } finally {
    busy = false;
  }
}

// 失败/中止收尾：把「用户说了什么」与「这轮怎么结束的」都落进线程。
// 收尾文案与落库**都在 runWorkspaceWatchTurn 里**（它按收尾类型给出「已停止」/
// 「超时未响应」/错误明细，并把用户消息与结论文案一并落线程）。
// 两条驱动路径（app 面板 / 悬浮窗）共用同一个函数 ⇒ 共用同一份收尾纪律，
// 不会出现「面板修好了、悬浮窗还空着」这种两处各写一遍的漂移。

/**
 * 悬浮窗回合的**统一出口**：跑完把结果推回窗（原生只做嘴和眼）。
 * 供 bridge 调用；分开是为了让「跑」与「推」各自可测。
 */
export async function runAndPushOverlayWorkspaceTurn({ text = '', signal = null, onBusy = null } = {}) {
  // P0-F：先给一条忙反馈——悬浮窗里不允许「发了话之后什么都没有」。
  // 用**状态行**而不是聊天气泡：气泡会留在历史里（用户会以为那是回复），
  // 而状态行在回合结束时被结果自然覆盖，语义正确。
  try {
    if (typeof onBusy === 'function') await onBusy();
    else await updateOverlayText(tActive('screenWatch.overlay.turnBusy'));
  } catch (error) {}
  const result = await runOverlayWorkspaceTurn({ text, signal });
  const reply = result.ok
    ? result.text
    : (result.error || tActive('screenWatch.comments.failed'));
  await pushOverlayChatMessage({ role: 'assistant', text: reply }).catch(() => {});
  return result;
}
