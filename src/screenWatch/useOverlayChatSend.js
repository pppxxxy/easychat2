// FEAT-AC4 P0-A：悬浮窗聊天回合的**编排 hook**（从 ScreenWatchScreen 外提）。
//
// 为什么单独一个文件：ScreenWatchScreen.js 已贴着 800 行棘轮，而「悬浮窗发来一句话
// → 按 scope 分流 → 跑管线 → 把回复推回窗」这块是自足的（自己的 busy 串行、自己的
// store/确认钩子、自己的错误收尾）——与 FrameRecognitionCard / AvatarCard 同一个理由。
//
// 本轮（P0-A）在此处修的**根因**：原先这里硬编码 `mode: 'read'` +
// `confirm: async () => false`（SW3 时代的取舍：悬浮窗不弹全屏 Alert）。
// 那让 AC1/AC2 的写类工具在悬浮窗里根本不可见、且一律自动拒绝——
// 「引擎接了、钥匙没给」。现在模式跟随 app 工作区设置，确认改为**窗内卡片**。

import { useCallback, useRef } from 'react';

import { runWorkspaceWatchTurn } from './workspaceWatchTurn.js';
import { runHeadlessAgent } from '../workspace/headlessAgent.js';
import { appendThreadEntry, getOrCreateActiveThread, THREAD_SCOPE_WORKSPACE } from './threads.js';
import { pushOverlayChatMessage, setOverlayScopeMode } from './overlay.js';
import { createOverlayConfirmHandler } from './overlayConfirmBridge.js';
import { createWorkspaceStore } from '../workspace/native.js';
import { readHookPermissionRules } from '../workspace/hooks.js';
import { readToolPermissionRules } from '../chat/toolApprovalFlow.js';
import { getWorkspaceSettings } from '../storage/workspace.js';

/**
 * 悬浮窗聊天回合处理器。
 *
 * @param {object} args
 * @param {(args: {userText: string}) => Promise<string>} args.generate 聊天 scope 的生成函数
 * @param {(error?: unknown) => string} args.errorText 失败文案（含脱敏）
 * @param {(key: string, vars?: object) => string} args.t i18n
 * @returns {(payload: {text: string, scope: string}) => Promise<void>}
 */
export function useOverlayChatSend({ generate, errorText, t }) {
  // 串行化：同一时刻只跑一条回合（避免连点叠加请求）。
  const busyRef = useRef(false);
  // store 惰性建一次（权限规则要读 hooks.json）。
  const storeRef = useRef(null);
  if (storeRef.current === null) storeRef.current = createWorkspaceStore({});
  // 窗内确认钩子（进程级单例在 bridge 里；这里只持引用）。
  const confirmRef = useRef(null);
  if (confirmRef.current === null) confirmRef.current = createOverlayConfirmHandler();

  const handler = useCallback(async ({ text, scope }) => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      if (scope === 'workspace') {
        const threadState = await getOrCreateActiveThread(
          'workspace',
          t('workspace.watch.assistantName'),
          Date.now(),
          THREAD_SCOPE_WORKSPACE
        ).catch(() => null);
        // 模式**跟随 app 工作区设置**（不再硬编码 read）。
        const workspaceSettings = await getWorkspaceSettings().catch(() => null);
        const workspaceMode = (workspaceSettings && workspaceSettings.mode) || 'ask';
        // 模式徽标（只读/可改）显示在标题行——用户要知道现在能不能改动。
        // 'ask' 档没有写工具，按只读显示（与 canRunTool 的实际放行一致）。
        setOverlayScopeMode(workspaceMode === 'write' ? 'write' : 'read').catch(() => {});
        const result = await runWorkspaceWatchTurn({
          userText: text,
          thread: threadState ? threadState.thread : null,
          mode: workspaceMode,
          runAgent: payload => runHeadlessAgent({
            ...payload,
            // 与 app 面板同源（ScreenWatchPanel 也这么传）——漏了它即便 mode=write，
            // headlessAgent 的 resolveHeadlessMode 仍可能把回合降级。
            allowWrite: workspaceMode === 'write',
          }),
          // 确认钩子：推**窗内卡片**并挂起等待（60s 超时按拒绝）。
          // 语义仍是 registry 的既定纪律「问不到用户 = 不执行」。
          confirm: confirmRef.current,
          // 权限规则：与工作区聊天同一条合并入口。不接这条，写工具上的手写 deny
          // 在看屏幕会话里会变成死键（既有 P0-2 事故的同款形态）。
          permissionRules: async () => readToolPermissionRules(
            await readHookPermissionRules(storeRef.current, 'workspace')
          ),
          appendEntry: appendThreadEntry,
          t,
        });
        await pushOverlayChatMessage({
          role: 'assistant',
          text: result.ok ? result.text : (result.error || t('screenWatch.comments.failed')),
        });
      } else {
        const reply = await generate({ userText: text });
        await pushOverlayChatMessage({ role: 'assistant', text: reply || errorText() });
      }
    } catch (error) {
      await pushOverlayChatMessage({ role: 'assistant', text: errorText(error) }).catch(() => {});
    } finally {
      busyRef.current = false;
    }
  }, [errorText, generate, t]);

  return handler;
}
