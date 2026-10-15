// FEAT-AC9 P1：工作区「对话」回合的**观测接线**（打点 + 工具事件）。
//
// 为什么单独一个文件：
//   ① **功能缺口**（P1 的证据）：主对话路径（ChatPanel → runAgentTurn 直连）
//      此前**没有注入 onTurnEvent** ⇒ 用户最常用的这条路径在诊断日志里完全隐形。
//      真机 02:51「关闭语音播报」那轮走的就是这里：日志里只有一行 `[app-setting] true->false`，
//      零 turn-* 痕迹。而它恰是 P1 七域工具（FEAT-AC6）的宿主——最该可观测的地方最瞎。
//   ② **行数棘轮**：ChatPanel.js 正卡在 1772 基线（阈值 = 实际值，不留余量）。
//      按仓库纪律「优先拆文件，不是改数字」，把这段内聚逻辑外提，
//      既补上了打点，又把基线降下来（见 architecture-baseline.json 的 _baselineChangeLog）。
//
// 边界（如实标注）：本模块**不**接 thread-append——那是 screenWatch 线程专属的落库留痕
//（工作区对话用 chats.js 持久化，不是 threads.js），硬接只会记出含义错误的行。

import { appendSessionEvent } from '../sessionEvents.js';
import { normalizePlanSteps } from '../toolDefs/planTool.js';
import { noteTurnEvent } from '../../screenWatch/turnDiagnostics.js';

/**
 * 回合打点的宿主接线（FEAT-AC9 P0-2 的两参契约由 noteTurnEvent 承载）。
 *
 * 为什么是函数而不是直接导出对象：调用方以 `...turnEventHostOptions()` spread 进
 * runAgentTurn 的 options——与既有的 confirmFlowHostOptions 同一形态
 *（见 confirmFlowBridge.js），保持「宿主接线的一段」这一既有写法。
 *
 * @returns {{ onTurnEvent: Function }}
 */
export function turnEventHostOptions() {
  return { onTurnEvent: noteTurnEvent };
}

/**
 * 工具事件处理器（从 ChatPanel 原样外提，行为逐字不变）。
 *
 * 两件事：① E4 会话事件流（旁路审计「第几步做了什么」）；② A3 二期计划进度条与
 * 运行中工具指示（纯展示，不落盘）。
 *
 * @param {object} deps
 * @param {{current: boolean}} deps.mountedRef 挂载标志（卸载后不再 setState）
 * @param {{current: object}} deps.storeRef 工作区 store（事件流落盘用）
 * @param {string} deps.ownerId 角色 id
 * @param {string} deps.chatId 会话 id
 * @param {Function} deps.setAgentPlan 计划清单 setter
 * @param {Function} deps.setLiveTool 运行中工具 setter
 * @returns {(event: object) => void}
 */
export function createAgentToolEventHandler({
  mountedRef,
  storeRef,
  ownerId,
  chatId,
  setAgentPlan,
  setLiveTool,
}) {
  return event => {
    if (!mountedRef.current || !event) return;
    if (event.phase === 'start') {
      // E4：事件流（旁路）——工具调用事实（含轮次，审计「第几步做了什么」）。
      appendSessionEvent(storeRef.current, ownerId, chatId, 'tool_call', {
        name: event.name,
        round: event.round,
      });
      // A3 二期：update_plan 的清单推进度条（状态展示；传空清单 = 清空）。
      if (event.name === 'update_plan') {
        const steps = normalizePlanSteps(event.args && event.args.plan);
        setAgentPlan(steps);
      }
    }
    setLiveTool(event.phase === 'start' ? { name: event.name, round: event.round, startedAt: Date.now() } : null);
  };
}
