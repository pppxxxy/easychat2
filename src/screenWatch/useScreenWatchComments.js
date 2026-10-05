// 看屏幕评论 hook：截屏 → 视觉门控校验 → 截图随 buildRequestMessages 的 images
// 参数走多模态 → 评论落库。链路与听歌/看书同款（stream:false + expectedConfig* 守卫），
// 差异点：请求带 images:[uri]；截图先存本地（重试不重复截屏，评论针对的是同一张）。
// 视觉门控与聊天附件菜单同一口径：在线 supportsVision 或本地模型多模态，任一可用。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { EMPTY_REPLY_TEXT, getConfigFingerprint, isCanceledError, sendChatMessage } from '../network/api.js';
import { buildRequestMessages } from '../prompt/chatPipeline.js';
import { getLocalModelMediaCapabilities } from '../localModel/modelState.js';
import {
  getActiveLocalModel,
  capabilitiesForModel,
  getApiConfigs,
  getActiveModel,
  getEnabledGlobalPresetPrompts,
  getLocalModelSettings,
  getUserProfile,
} from '../storage.js';

import { appendScreenWatchComment, getScreenWatchComments } from './comments.js';
import { buildScreenWatchPrompt } from './commentPrompts.js';
import { readImageDataUri } from '../chat/attachments.js';
import { useTranslation } from '../i18n/I18nContext.js';

const COMMENT_TEXT_MAX = 2000;

// 解析当前模型能力：在线来源 supportsVision/supportsVideo 或本地多模态。
// 供「生成前门控」与悬浮窗「视频帧序列」判定复用；读盘失败按不支持处理。
export async function resolveScreenWatchCapabilities() {
  const [apiConfig, localSettings, localItem] = await Promise.all([
    getApiConfigs(),
    getLocalModelSettings().catch(() => null),
    getActiveLocalModel().catch(() => null),
  ]);
  const current = apiConfig.configs.find(item => item.id === apiConfig.activeId)
    || apiConfig.configs[0];
  // 能力按当前模型解析（同一配置下每个模型一套能力）。
  const caps = capabilitiesForModel(current, current ? getActiveModel(current) : '');
  const vision = caps.supportsVision === true
    || !!getLocalModelMediaCapabilities(localSettings, localItem).vision;
  const video = caps.supportsVideo === true;
  return { vision, video, current };
}

export function useScreenWatchComments({ characters, defaultCharacterId = '' }) {
  const [comments, setComments] = useState([]);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const [characterId, setCharacterId] = useState(String(defaultCharacterId || ''));
  const { t } = useTranslation();

  const charactersRef = useRef(characters);
  charactersRef.current = characters;
  const characterIdRef = useRef(characterId);
  characterIdRef.current = characterId;
  const generatingRef = useRef(false);
  const abortRef = useRef(null);
  const lastFailedRef = useRef(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (abortRef.current) abortRef.current.abort();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setError('');
    lastFailedRef.current = null;
    getScreenWatchComments()
      .then(list => {
        if (!cancelled) setComments(list);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const generate = useCallback(async ({ imageUri, imageUris } = {}) => {
    // 兼容单帧（imageUri）与视频帧序列（imageUris）；两者都为空则纯文字。
    const uris = (Array.isArray(imageUris) ? imageUris : [])
      .map(item => String(item || ''))
      .filter(Boolean);
    if (uris.length === 0 && imageUri) uris.push(String(imageUri));
    if (generatingRef.current) return false;
    const character = (charactersRef.current || []).find(item => item.id === characterIdRef.current);
    if (!character) {
      setError(t('screenWatch.error.noCharacter'));
      return false;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    generatingRef.current = true;
    setGenerating(true);
    setError('');
    try {
      const [profile, presets, caps] = await Promise.all([
        getUserProfile().catch(() => null),
        getEnabledGlobalPresetPrompts().catch(() => []),
        resolveScreenWatchCapabilities(),
      ]);
      if (controller.signal.aborted) return false;
      // 视觉门控：与聊天附件菜单同一口径。读盘失败按不支持处理（给明确提示）。
      if (!caps.vision) {
        throw Object.assign(new Error(t('screenWatch.error.noVision')), { code: 'NO_VISION' });
      }
      const current = caps.current;
      // 关键：接口的 image_url 只接受 data: URI 或 http(s) URL。截图是本地 file:// 路径，
      // 直接塞进 images 会让请求携带 file:// URL，被服务端拒绝/忽略（聊天路径就是先读成
      // base64 data URI 再发）；这里同样把每帧读成 data URI，本地路径仍留给落库与重试。
      let dataUris = [];
      try {
        dataUris = await Promise.all(uris.map(uri => readImageDataUri(uri)));
      } catch (readError) {
        throw Object.assign(new Error('截图读取失败'), { code: 'CAPTURE_READ' });
      }
      if (controller.signal.aborted) return false;
      const requestMessages = buildRequestMessages({
        character,
        historyMessages: [],
        userText: buildScreenWatchPrompt(),
        userProfile: profile || {},
        globalPresets: presets,
        summaryText: '',
        memorySnippets: '',
        pluginContext: '',
        images: dataUris,
        quote: null,
      });
      const raw = await sendChatMessage(requestMessages, {
        stream: false,
        signal: controller.signal,
        expectedConfigId: String((current && current.id) || ''),
        expectedConfigFingerprint: current ? getConfigFingerprint(current) : '',
      });
      if (controller.signal.aborted) return false;
      // 接口空响应返回占位文本：那不是角色评论，按失败处理。
      const text = String(raw || '').trim();
      if (!text || text === EMPTY_REPLY_TEXT) throw new Error('没有收到回复内容');
      const comment = {
        id: `sw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        characterId: character.id,
        // 名字留空：显示层按当前语言补「角色」，切语言后旧评论也跟着变。
        characterName: String(character.name || '').trim(),
        text: text.slice(0, COMMENT_TEXT_MAX),
        imageUri: uris[0] || '',
        createdAt: Date.now(),
      };
      const next = await appendScreenWatchComment(comment);
      if (mountedRef.current) setComments(next);
      lastFailedRef.current = null;
      return text;
    } catch (caught) {
      if (controller.signal.aborted || isCanceledError(caught)) return false;
      if (mountedRef.current) {
        if (caught && caught.code === 'NO_VISION') setError(caught.message);
        else if (caught && caught.code === 'CAPTURE_READ') setError(t('screenWatch.capture.failed.body'));
        else setError(t('screenWatch.comments.failed'));
      }
      lastFailedRef.current = { imageUri: uris[0] || '', imageUris: uris };
      return false;
    } finally {
      generatingRef.current = false;
      if (abortRef.current === controller) abortRef.current = null;
      if (mountedRef.current) setGenerating(false);
    }
  }, []);

  const retry = useCallback(() => {
    const failed = lastFailedRef.current;
    if (!failed) return Promise.resolve(false);
    return generate(failed);
  }, [generate]);

  return useMemo(() => ({
    comments,
    generating,
    error,
    characterId,
    setCharacterId,
    generate,
    retry,
  }), [comments, generating, error, characterId, generate, retry]);
}
