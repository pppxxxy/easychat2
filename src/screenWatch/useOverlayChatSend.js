// FEAT-AC4 P0-A：悬浮窗**聊天 scope** 回合的编排 hook（从 ScreenWatchScreen 外提）。
//
// 为什么单独一个文件：ScreenWatchScreen.js 已贴着 800 行棘轮，而「悬浮窗发来一句话
// → 跑角色评论管线 → 把回复推回窗」这块是自足的（自己的 busy 串行、自己的错误收尾）
// ——与 FrameRecognitionCard / AvatarCard 同一个理由。
//
// ⚠️ FEAT-AC7 P0-A 起**本 hook 只处理聊天 scope**：工作区 scope 已外提到
// overlayWorkspaceTurn.js（app 级常驻，页面不在场也能跑），分流在 overlayEventBridge
// 里做，工作区**不会**走到这里。
//
// 为什么删掉这里原有的工作区分支（不是「顺手清理」）：AC7 之后它是**不可达代码**，
// 而它和 overlayWorkspaceTurn 是同一件事的两份实现——保留两份必然漂移，
// 更糟的是**守卫会钉在死代码上**：实测把活路径的 allowWrite / permissionRules /
// confirm / mode 逐个删掉，测试**全绿**（守卫查的是这份不可达的旧实现）。
// 故本文件只留聊天 scope，工作区相关的守卫全部移到活路径（overlayTurnResilience.test.mjs）。

import { useCallback, useRef } from 'react';

import { pushOverlayChatMessage } from './overlay.js';

/**
 * 悬浮窗聊天回合处理器（**仅聊天 scope**）。
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

  const handler = useCallback(async ({ text }) => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      const reply = await generate({ userText: text });
      await pushOverlayChatMessage({ role: 'assistant', text: reply || errorText() });
    } catch (error) {
      await pushOverlayChatMessage({ role: 'assistant', text: errorText(error) }).catch(() => {});
    } finally {
      busyRef.current = false;
    }
  }, [errorText, generate, t]);

  return handler;
}
