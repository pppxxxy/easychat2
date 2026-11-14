// 自动配图（桌面）：角色回复结束后按「内联配图设置」生成一张图挂到该消息上。
//
// 与手机同一条链路，判定全在共享层：
//   · imageGen/inlineImagePrompt  —— selectReplySegment / buildScenePrompt /
//     normalizeScenePrompt / resolveInlineImageSceneText（本轮从 ChatScreen 抽出，
//     两端复用；智能增强的「先转写画面描述」就是它）；
//   · imageGen/chatHelpers.buildInlineImagePrompt —— 加风格前缀并按上限截断；
//   · imageGen/index.generateImage —— 端点/载荷/解析/错误映射。
//
// 桌面唯一与手机不同的是「图片落到哪」：手机存 data URI 或远程 url，桌面渲染层
// 只能通过 easychat2-media:// 读 documents/ 下的文件，所以这里统一落盘并登记媒体保护
// （与 ImageGenScreen 同一套：先写盘、再 markMediaWrite，避免孤儿回收误删）。
//
// 开关语义与手机一致：inlineImageEnabledRef 只在设置启用时才驱动 useChatSend 的
// 自动配图分支；手动点「生成配图」不受开关限制（与播报同一纪律）。
import { useCallback, useEffect, useRef, useState } from 'react';

import { getConfigFingerprint, sendChatMessage, EMPTY_REPLY_TEXT } from '../../../src/network/api.js';
import { buildInlineImagePrompt } from '../../../src/chat/chatHelpers.js';
import { generateImage } from '../../../src/imageGen/index.js';
import { getImageProvider } from '../../../src/imageGen/providers.js';
import {
  INLINE_SCENE_PROMPT_KEY,
  resolveInlineImageSceneText,
} from '../../../src/imageGen/inlineImagePrompt.js';
import { tActive } from '../../../src/i18n/index.js';
import {
  getInlineImageSettings,
  saveInlineImageSettings,
} from '../../../src/storage/settings/chatOptions.js';
import { getImageGenSettings } from '../../../src/storage/settings/imageGen.js';
import { markMediaWrite } from '../../../src/storage/mediaProtection.js';
import { maskSecrets } from '../../../src/storage/secrets.js';
import { getApiConfigs } from '../../../src/storage/apiConfigs.js';
import { getBridge } from '../platform/bridge.js';
import { documentDirectory } from '../platform/fileSystem.js';

// 默认值与共享层 normalizeInlineImage 的 DEFAULT_INLINE_IMAGE 保持一致：
// 这里只是在「还没读到设置」时给界面一个可渲染的形状，读了就以存储为准。
const DEFAULT_SETTINGS = Object.freeze({
  enabled: false,
  providerId: '',
  stylePrefix: '',
  size: '832*1216',
  maxPromptChars: 400,
  imagePosition: 'end',
  enhance: false,
  enhanceConfigId: '',
});

export default function useDesktopInlineImage({
  messagesRef = null,
  setInlineImage = null,
}) {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const settingsRef = useRef(DEFAULT_SETTINGS);
  settingsRef.current = settings;
  const busyRef = useRef(false);
  const controllerRef = useRef(null);

  // 读设置；失败按关闭处理（不因为读坏就把配图跑起来）。
  const reload = useCallback(async () => {
    try {
      const next = await getInlineImageSettings();
      setSettings({ ...DEFAULT_SETTINGS, ...next });
    } catch (error) {
      setSettings(DEFAULT_SETTINGS);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const persist = useCallback(async next => {
    const merged = { ...settingsRef.current, ...next };
    const saved = await saveInlineImageSettings(merged);
    setSettings({ ...DEFAULT_SETTINGS, ...saved });
    return saved;
  }, []);

  // 生成一张图挂到 messageId 上。三态（loading/error/done）与手机一致。
  const generateFor = useCallback(async (messageId, replyText) => {
    if (busyRef.current) return false;
    const current = settingsRef.current;
    const providerId = String(current.providerId || '');
    if (!providerId) return false;
    const provider = getImageProvider(providerId);

    let genConfig = null;
    try {
      const stored = await getImageGenSettings();
      genConfig = (stored && stored.providers && stored.providers[providerId]) || null;
    } catch (error) {
      genConfig = null;
    }
    if (!genConfig || !String(genConfig.baseUrl || provider.baseUrl || '').trim()) return false;

    const controller = new AbortController();
    controllerRef.current = controller;
    busyRef.current = true;
    setMessagesInline(messageId, { status: 'loading' });
    try {
      const sceneText = await resolveInlineImageSceneText({
        replyText,
        settings: current,
        messages: Array.isArray(messagesRef && messagesRef.current) ? messagesRef.current : [],
        messageId,
        charName: '',
        userName: '',
        emptyReplyText: EMPTY_REPLY_TEXT,
        signal: controller.signal,
        sendScene: async ({ prompt, signal }) => {
          const { configs, activeId } = await getApiConfigs();
          const config = configs.find(item => item.id === String(current.enhanceConfigId || ''))
            || configs.find(item => item.id === activeId)
            || configs[0];
          if (!config) return '';
          return sendChatMessage(
            [
              { role: 'system', content: tActive(INLINE_SCENE_PROMPT_KEY) },
              { role: 'user', content: prompt },
            ],
            {
              stream: false,
              signal,
              expectedConfigId: String(config.id || ''),
              expectedConfigFingerprint: getConfigFingerprint(config),
            }
          );
        },
      });
      if (controller.signal.aborted) return false;

      const prompt = buildInlineImagePrompt(sceneText, current.stylePrefix, current.maxPromptChars);
      if (!prompt) throw new Error('inline image prompt is empty');
      const generated = await generateImage({
        provider,
        config: genConfig,
        prompt,
        size: current.size || undefined,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return false;

      const first = Array.isArray(generated && generated.images) ? generated.images[0] : null;
      const raw = first && (first.base64 || first.data || first.url);
      if (!raw) {
        setMessagesInline(messageId, { status: 'error', message: '' });
        return false;
      }
      // 落盘到 documents/chat-images/：渲染层只能经 easychat2-media:// 读这里的文件。
      const destination = `${documentDirectory}chat-images/inline-${messageId}-${Date.now()}.png`;
      const bridge = getBridge();
      if (/^https?:/i.test(String(raw))) {
        await bridge.fs.download(String(raw), destination);
      } else {
        const base64 = String(raw).replace(/^data:[^;]+;base64,/, '');
        await bridge.fs.write(destination, base64, 'base64');
      }
      markMediaWrite(destination);
      setMessagesInline(messageId, { status: 'done', uri: destination });
      return true;
    } catch (error) {
      if (!controller.signal.aborted) {
        setMessagesInline(messageId, {
          status: 'error',
          message: maskSecrets(String((error && error.message) || '')),
        });
      }
      return false;
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
      busyRef.current = false;
    }
  }, [messagesRef]);

  // 把三态挂到消息上：setter 由宿主传入（它持有消息 state）。
  // 用 ref 持有最新 setter——调用发生在 await 之后，闭包里的旧 setter 也仍然有效，
  // 但换会话时宿主可能换了一份 state，用 ref 才不会写到旧列表上。
  const setterRef = useRef(setInlineImage);
  setterRef.current = setInlineImage;
  const setMessagesInline = useCallback((messageId, inlineImage) => {
    const setter = setterRef.current;
    if (typeof setter !== 'function') return;
    setter(messageId, inlineImage);
  }, []);

  return {
    settings,
    reload,
    persist,
    generateFor,
  };
}