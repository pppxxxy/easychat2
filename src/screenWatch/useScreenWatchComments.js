// 看屏幕评论 hook：截屏 → 视觉门控校验 → 截图随 buildRequestMessages 的 images
// 参数走多模态 → 评论落库。链路与听歌/看书同款（stream:false + expectedConfig* 守卫），
// 差异点：请求带 images:[uri]；截图先存本地（重试不重复截屏，评论针对的是同一张）。
// 视觉门控与聊天附件菜单同一口径：在线 supportsVision 或本地模型多模态，任一可用。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { EMPTY_REPLY_TEXT, getConfigFingerprint, isCanceledError, sendChatMessage } from '../network/api.js';
import { buildRequestMessages } from '../prompt/chatPipeline.js';
import { getLocalModelMediaCapabilities } from '../localModel/modelState.js';
import { getActiveLocalModel, getLocalModelSettings } from '../storage/localModels.js';
import { capabilitiesForModel, getApiConfigs, getActiveModel } from '../storage/apiConfigs.js';
import { getEnabledGlobalPresetPrompts } from '../storage/globalPresets.js';
import { getUserProfile } from '../storage/personas.js';

import { maskSecrets } from '../storage/secrets.js';
import { appendScreenWatchComment, clearScreenWatchComments, deleteScreenWatchComment, getScreenWatchComments } from './comments.js';
import { buildScreenWatchPrompt } from './commentPrompts.js';
import {
  THREAD_ROLE_CHARACTER,
  THREAD_ROLE_USER,
  appendThreadEntry,
  getOrCreateActiveThread,
} from './threads.js';
import { readImageDataUri } from '../chat/attachments.js';
import { useTranslation } from '../i18n/I18nContext.js';

const COMMENT_TEXT_MAX = 2000;
// 注入给模型的历史条数上限（约 6 轮）：够角色记住这场对话，又不淹没当前画面。
const THREAD_HISTORY_MAX = 12;

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
  // 最后一次失败的完整文案（含真实原因）：面板读 error state，悬浮窗小窗在面板外，
  // 只能靠这个 ref 拿到同一份说明来回写。
  const lastErrorRef = useRef('');
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

  const generate = useCallback(async ({ imageUri, imageUris, userText } = {}) => {
    // 兼容单帧（imageUri）与视频帧序列（imageUris）；两者都为空则纯文字。
    const uris = (Array.isArray(imageUris) ? imageUris : [])
      .map(item => String(item || ''))
      .filter(Boolean);
    if (uris.length === 0 && imageUri) uris.push(String(imageUri));
    if (generatingRef.current) return false;
    const character = (charactersRef.current || []).find(item => item.id === characterIdRef.current);
    if (!character) {
      const message = t('screenWatch.error.noCharacter');
      lastErrorRef.current = message;
      setError(message);
      return false;
    }
    // 用户主动说话（悬浮窗/面板的输入）：纯文字且没内容就不发请求。
    const saidText = String(userText || '').trim();
    if (uris.length === 0 && !saidText) return false;
    const controller = new AbortController();
    abortRef.current = controller;
    generatingRef.current = true;
    setGenerating(true);
    setError('');
    lastErrorRef.current = '';
    try {
      const [profile, presets, caps, threadState] = await Promise.all([
        getUserProfile().catch(() => null),
        getEnabledGlobalPresetPrompts().catch(() => []),
        resolveScreenWatchCapabilities(),
        // 对话线程（同角色 + 未超空闲阈值即续用）：连续截屏/说话算同一场对话。
        getOrCreateActiveThread(character.id, character.name).catch(() => null),
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
        throw Object.assign(new Error(t('error.screenWatch.captureReadFailed')), { code: 'CAPTURE_READ' });
      }
      if (controller.signal.aborted) return false;
      // 对话线程历史（不含本次要说的话）：让角色记住这场对话的前文，连续截屏不再各说各话。
      const thread = threadState ? threadState.thread : null;
      const historyMessages = (thread ? thread.entries : [])
        .slice(-THREAD_HISTORY_MAX)
        .map(entry => ({ id: entry.id, role: entry.role, text: entry.text }));
      const requestMessages = buildRequestMessages({
        character,
        historyMessages,
        // 用户主动说话时以他的话为主（同时带截图则先说明在看屏幕）；否则走原评论提示。
        userText: saidText
          ? (uris.length > 0
            ? `${buildScreenWatchPrompt()}\n\n用户看着屏幕说：${saidText}`
            : saidText)
          : buildScreenWatchPrompt(),
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
      if (!text || text === EMPTY_REPLY_TEXT) throw new Error(t('error.comments.noReply'));
      // 对话线程落库：用户的话（若有）+ 角色回复。写线程失败不影响本次评论结果。
      if (thread) {
        try {
          if (saidText) {
            await appendThreadEntry(thread.id, {
              id: `swu-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              role: THREAD_ROLE_USER,
              text: saidText,
              imageUri: uris[0] || '',
              at: Date.now(),
            });
          }
          await appendThreadEntry(thread.id, {
            id: `swc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            role: THREAD_ROLE_CHARACTER,
            text: text.slice(0, COMMENT_TEXT_MAX),
            imageUri: uris[0] || '',
            at: Date.now(),
          });
        } catch (error) {}
      }
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
      lastErrorRef.current = '';
      return text;
    } catch (caught) {
      if (controller.signal.aborted || isCanceledError(caught)) return false;
      let message;
      if (caught && caught.code === 'NO_VISION') message = caught.message;
      else if (caught && caught.code === 'CAPTURE_READ') message = t('screenWatch.capture.failed.body');
      else {
        // 真实原因必须露出来：此前一律显示「评论生成失败，请检查 API 配置后重试」，
        // 把服务端报错、网络失败、空响应、守卫拦截全归成同一句话——用户明明配的是
        // 多模态模型，却被告知去检查 API 配置，排查方向直接被带偏。
        const detail = maskSecrets(String((caught && caught.message) || '')).trim();
        message = detail
          ? `${t('screenWatch.comments.failed')}\n${detail}`
          : t('screenWatch.comments.failed');
      }
      lastErrorRef.current = message;
      if (mountedRef.current) setError(message);
      lastFailedRef.current = { imageUri: uris[0] || '', imageUris: uris, userText: saidText };
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

  // 删除单条评论卡片（幂等）：失败静默（与 MemoryScreen 删线程的 .catch 同范式）。
  // 只动 comments 存储；对话线程在记忆页管理，不做级联。
  const remove = useCallback(id => deleteScreenWatchComment(id)
    .then(next => {
      if (mountedRef.current) setComments(next);
    })
    .catch(() => {}), []);

  // 清空全部评论：数据层 clearScreenWatchComments 一直存在，此前没有任何 UI 接线。
  const clearAll = useCallback(() => clearScreenWatchComments()
    .then(() => {
      if (mountedRef.current) setComments([]);
    })
    .catch(() => {}), []);

  return useMemo(() => ({
    comments,
    generating,
    error,
    lastErrorRef,
    characterId,
    setCharacterId,
    generate,
    retry,
    remove,
    clearAll,
  }), [clearAll, comments, generating, error, characterId, generate, remove, retry]);
}
