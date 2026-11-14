// 通知点击 → 跳会话（桌面）。
//
// 手机侧由 ProactiveMessageBridge 处理原生 intent（冷启动/热启动两种路径）；
// 桌面侧等价物是主进程的 notify:click 回传：点击系统通知时主进程把
// { characterId, sessionId, messageId } 原样发回渲染层，这里负责导航。
//
// 抽成 hook 而不是留在 DesktopApp：那边已到 800 行棘轮，且这段是「订阅 + 导航」
// 的独立职责，与主壳的渲染无关。
import { useEffect } from 'react';

import { getBridge } from '../platform/bridge.js';

export default function useDesktopNotificationJump({
  enabled = true,
  onJump,
} = {}) {
  useEffect(() => {
    if (!enabled) return undefined;
    const bridge = getBridge();
    if (!bridge || !bridge.notify || typeof bridge.notify.onClick !== 'function') return undefined;
    const off = bridge.notify.onClick(target => {
      if (!target || typeof onJump !== 'function') return;
      const sessionId = String(target.sessionId || '');
      if (!sessionId) return;
      onJump({
        characterId: String(target.characterId || ''),
        sessionId,
        messageId: String(target.messageId || ''),
      });
    });
    return () => { if (typeof off === 'function') off(); };
  }, [enabled, onJump]);
}
