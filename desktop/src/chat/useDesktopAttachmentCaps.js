// 附件能力位（桌面）：当前模型是否吃图片 / 视频。
//
// 为什么需要它：手机 AttachmentMenuModal 按 visionEnabled / videoEnabled 把「拍照 /
// 相册 / 拍视频 / 视频」置灰并**当场说明原因**；桌面此前是三个常亮按钮，用户选完
// 文件才在发送侧被拒（useChatSend 里仍是最后一道闸，但那时已经让人白选了一次）。
//
// 口径与发送侧**完全一致**（照抄 useChatSend:1387-1392）：
//   · vision = caps.supportsVision；
//   · video  = caps.supportsVideo 且线协议为 openai（video_url 是 OpenAI 兼容端点的
//     扩展类型，Responses / Anthropic 都没有视频输入）。
// 能力按**当前模型**解析（同一配置下每个模型一套能力），取法与
// useDesktopContextUsage 相同。
import { useEffect, useState } from 'react';

import { capabilitiesForModel, getActiveModel } from '../../../src/storage/apiConfigs.js';
import { getCharacterApiConfigs } from '../../../src/character/runtimeConfig.js';

export default function useDesktopAttachmentCaps({ characterId = '' } = {}) {
  const [caps, setCaps] = useState({ vision: false, video: false, ready: false });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // 走角色解析层：角色的专属聊天 API/模型会改变「当前模型是谁」，
        // 门控必须跟着变（否则会出现「门控按全局判、请求按专属发」的错配）。
        const resolved = await getCharacterApiConfigs(String(characterId || ''));
        const current = (resolved.configs || []).find(item => item.id === resolved.activeId)
          || (resolved.configs || [])[0];
        if (!current) {
          if (!cancelled) setCaps({ vision: false, video: false, ready: true });
          return;
        }
        const model = getActiveModel(current);
        const modelCaps = capabilitiesForModel(current, model);
        const vision = modelCaps.supportsVision === true;
        const video = modelCaps.supportsVideo === true
          && String(current.protocol || 'openai') === 'openai';
        if (!cancelled) setCaps({ vision, video, ready: true });
      } catch (error) {
        // 读不出能力就按不支持处理（与发送侧同一保守方向）。
        if (!cancelled) setCaps({ vision: false, video: false, ready: true });
      }
    })();
    return () => { cancelled = true; };
  }, [characterId]);

  return caps;
}