// 桌面聊天页的上下文占用（与 Android ChatScreen 同一口径）。
//
// 窗口来源：角色生效 API 配置里「当前模型声明的 contextWindow」优先；桌面没有本地模型，
// 因此 localContextSize 恒为 0，最后回落到模型家族建议/默认窗口（共享 resolveContextWindow）。
// 只在消息条数变化时重算，避免流式期间每个 token 都做一次全量 token 估算。
import { useEffect, useRef, useState } from 'react';

import { capabilitiesForModel, getActiveModel } from '../../../src/storage/apiConfigs.js';
import { getCharacterApiConfigs } from '../../../src/character/runtimeConfig.js';
import { EMPTY_USAGE, usageFromMessages } from './usageView.js';

export default function useDesktopContextUsage({ messages, characterId, enabled = true }) {
  const [usage, setUsage] = useState(EMPTY_USAGE);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const count = Array.isArray(messages) ? messages.length : 0;

  useEffect(() => {
    if (!enabled) {
      setUsage(EMPTY_USAGE);
      return undefined;
    }
    let alive = true;
    (async () => {
      let declared = 0;
      let maxOutput = 0;
      let model = '';
      try {
        const { configs, activeId } = await getCharacterApiConfigs(characterId);
        const current = configs.find(item => item.id === activeId) || configs[0];
        if (current) {
          model = getActiveModel(current);
          const caps = capabilitiesForModel(current, model);
          declared = Number(caps.contextWindow) || 0;
          maxOutput = Number(caps.maxOutput) || 0;
        }
      } catch (error) {
        // 配置读不出就按默认窗口估算：占用条仍然可用，只是窗口取保守默认。
      }
      if (!alive) return;
      setUsage(usageFromMessages(messagesRef.current, { declared, maxOutput, model }));
    })();
    return () => { alive = false; };
  }, [count, characterId, enabled]);

  return usage;
}