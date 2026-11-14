// 主动消息的「前台到点」调度（桌面）。
//
// 手机侧靠 Android AlarmReceiver 在**进程退出后**也能唤起；桌面没有等价载体，所以
// 这里只做诚实的那一半：**应用窗口开着时**到点就生成并提醒。文案里已明确写了这一点
// （desktop.proactive.desktopOnlyHint），不假装能在关闭后触发。
//
// 判定全部复用共享层：
//   · storage/moments.js 的 slots（roleId / hour / minute / windowMinutes / styles / sessionTargetId）；
//   · proactive/proactiveRequest 的 buildProactiveVariants（按权重抽风格 + 任务句）；
//   · storage/sessionMessages 的 appendProactiveMessage（幂等：同槽同日不重复）。
import { useCallback, useEffect, useRef } from 'react';

import { buildProactiveVariants } from '../../../src/proactive/proactiveRequest.js';
import { buildProactiveMessageId } from '../../../src/proactive/proactiveInbox.js';
import { appendProactiveMessage } from '../../../src/storage/sessionMessages.js';
import { getProactiveSettings } from '../../../src/storage/moments.js';
import { getCharacterApiConfigs } from '../../../src/character/runtimeConfig.js';
import { getConfigFingerprint, sendChatMessage } from '../../../src/network/api.js';
import { buildRequestMessages } from '../../../src/prompt/chatPipeline.js';
import { getBridge } from '../platform/bridge.js';
import { isSlotDue, pickVariant } from './slotTiming.js';

const POLL_MS = 60 * 1000;

export { isSlotDue, pickVariant } from './slotTiming.js';

export default function useProactiveForeground({ enabled, charactersRef }) {
  const runningRef = useRef(false);

  const tick = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    try {
      const settings = await getProactiveSettings().catch(() => null);
      const slots = settings && Array.isArray(settings.slots) ? settings.slots : [];
      const now = new Date();
      const due = slots.filter(slot => isSlotDue(slot, now));
      if (due.length === 0) return;
      const characters = Array.isArray(charactersRef.current) ? charactersRef.current : [];

      for (const slot of due) {
        const character = characters.find(item => item.id === String(slot.roleId || ''));
        // 角色被删了：跳过（不静默造一条无主消息）。
        if (!character) continue;
        const variant = pickVariant(buildProactiveVariants(slot.styles));
        if (!variant) continue;

        const { configs, activeId } = await getCharacterApiConfigs(character.id);
        const config = configs.find(item => item.id === activeId) || configs[0];
        if (!config) continue;

        const reply = await sendChatMessage(
          buildRequestMessages({
            character,
            historyMessages: [],
            userText: '',
            // 「这是你主动开口」的指令由共享层生成（含字数与格式约束）。
            extraSystemPrompt: variant.task,
          }),
          {
            stream: false,
            expectedConfigId: String(config.id || ''),
            expectedConfigFingerprint: getConfigFingerprint(config),
          }
        );
        const text = String(reply == null ? '' : reply).trim();
        if (!text) continue;

        // 落库：幂等（同槽同日只一条），并复用槽已绑定的会话。
        await appendProactiveMessage(character.id, {
          id: buildProactiveMessageId(slot.slotId, now),
          text,
          sessionTargetId: String(slot.sessionTargetId || ''),
          createdAt: Date.now(),
          proactive: true,
          slotId: String(slot.slotId || ''),
        }).catch(() => {});

        // 系统通知：窗口开着时的提醒。不可用时只记一条 warn（消息已落库，进会话就能看到）。
        try {
          const shown = await getBridge().notify.show({
            title: String(character.name || '') || undefined,
            body: text.slice(0, 200),
            // 点击通知要跳到这条消息所在的会话（与手机 ProactiveMessageBridge 同一语义）。
            // 主进程不解释这些字段，只原样回传给渲染层。
            target: {
              characterId: String(character.id || ''),
              sessionId: String(slot.sessionTargetId || ''),
              messageId: buildProactiveMessageId(slot.slotId, now),
            },
          });
          if ((!shown || shown.ok !== true) && typeof console !== 'undefined' && console.warn) {
            console.warn('[proactive] system notification unavailable:', shown && shown.reason);
          }
        } catch (error) {}
      }
    } finally {
      runningRef.current = false;
    }
  }, [charactersRef]);

  useEffect(() => {
    if (!enabled) return undefined;
    // 打开即查一次（窗口可能刚好在到点时打开），之后每分钟一次。
    tick();
    const timer = setInterval(tick, POLL_MS);
    return () => clearInterval(timer);
  }, [enabled, tick]);

  return { tick };
}
