// 一起听歌的角色评论 hook：打点/开场触发 → 组 prompt → 组装消息（可含歌曲音频片段）
// → 经 sendWithModelProvider 路由（本地多模态模型优先，失败回退在线）→ appendMusicComment 落库。
// 评论只在面板内呈现、不进聊天会话（2026-10-03 用户裁决）；「接话」由界面层处理。
// 生成串行：同一时刻至多一次请求，新的触发在生成期间直接跳过（触发位已记 fired，
// 失败可从错误条重试，不会因跳过而永久丢失——重试走直调，不依赖 crossing）。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { EMPTY_REPLY_TEXT, getConfigFingerprint, isCanceledError, sendChatMessage } from '../network/api.js';
import { canUseLocalModel, sendWithModelProvider } from '../network/modelProvider.js';
import { buildRequestMessages, filterRequestMedia } from '../prompt/chatPipeline.js';
import { getActiveLocalModel, getLocalModelSettings } from '../storage/localModels.js';
import { getApiConfigs } from '../storage/apiConfigs.js';
import { getEnabledGlobalPresetPrompts } from '../storage/globalPresets.js';
import { getUserProfile } from '../storage/personas.js';
import { getLocalModelMediaCapabilities } from '../localModel/modelState.js';
import { getLocalModelFileInfo } from '../localModel/modelManager.js';

import { appendMusicComment, getMusicComments } from './comments.js';
import { readAudioFileBase64 } from './importMusic.js';
import {
  MUSIC_AUDIO_MAX_BYTES,
  MUSIC_DECODE_MAX_BYTES,
  buildOpeningCommentPrompt,
  buildTriggerCommentPrompt,
  canAttachSongAudio,
  resolveAudioSupport,
} from './commentPrompts.js';
import { CLIP_DURATION_MS, CLIP_SAMPLE_RATE } from './audioClip.js';
import { useTranslation } from '../i18n/I18nContext.js';

const COMMENT_TEXT_MAX = 2000;

// 读取歌曲文件为 base64（走 music 域的文件读取封装）。读盘失败返回 null。
async function readSongBase64(currentSong) {
  const song = currentSong && typeof currentSong === 'object' ? currentSong : {};
  const base64 = await readAudioFileBase64(song.uri);
  return base64 || null;
}

// 准备随评论发送的音频：优先用 WebView 裁剪出从 startMs 起的一段 WAV（体积小、
// 规避端点时长上限）；无法裁剪时退回整首原文件（仅当不超 25MB）。都不可用返回 null，
// 调用方退回纯文字评论（不阻断功能）。
export async function prepareSongAudioForModel(
  currentSong,
  clipAudio,
  { startMs = 0, durationMs = CLIP_DURATION_MS, sampleRate = CLIP_SAMPLE_RATE } = {}
) {
  const song = currentSong && typeof currentSong === 'object' ? currentSong : {};
  if (!canAttachSongAudio(song, MUSIC_DECODE_MAX_BYTES)) return null;
  const canClip = typeof clipAudio === 'function';
  // 裁剪路径读取整首解码；整首发送路径只在体积达标时读取。
  if (!canClip && !canAttachSongAudio(song, MUSIC_AUDIO_MAX_BYTES)) return null;
  const base64 = await readSongBase64(song);
  if (!base64) return null;
  if (canClip) {
    try {
      const clipped = await clipAudio({ base64, startMs, durationMs, sampleRate });
      if (clipped && clipped.base64) return { base64: clipped.base64, mime: clipped.mime || 'audio/wav' };
    } catch (error) {
      // 裁剪失败（编解码不支持等）→ 退回整首原始音频。
    }
  }
  if (canAttachSongAudio(song, MUSIC_AUDIO_MAX_BYTES)) {
    return { base64, mime: String(song.mime || '').trim() };
  }
  return null;
}

export function useMusicComments({ song, characters, defaultCharacterId = '', clipAudio = null, clipSettings = null }) {
  const [comments, setComments] = useState([]);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const [characterId, setCharacterId] = useState(String(defaultCharacterId || ''));
  // null = 能力未知（尚未读出配置）；false = 当前来源不具备听音频能力。
  const [audioSupported, setAudioSupported] = useState(null);
  const { t } = useTranslation();

  const songRef = useRef(song);
  songRef.current = song;
  const charactersRef = useRef(characters);
  charactersRef.current = characters;
  const characterIdRef = useRef(characterId);
  characterIdRef.current = characterId;
  const clipAudioRef = useRef(clipAudio);
  clipAudioRef.current = clipAudio;
  const clipSettingsRef = useRef(clipSettings);
  clipSettingsRef.current = clipSettings;
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

  // 换歌：中断在途生成、重置错误与重试位，并装载新歌的历史评论。
  const songId = song ? song.id : '';
  useEffect(() => {
    if (abortRef.current) abortRef.current.abort();
    setError('');
    lastFailedRef.current = null;
    setComments([]);
    if (!songId) return undefined;
    let cancelled = false;
    getMusicComments(songId)
      .then(list => {
        if (!cancelled) setComments(list);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [songId]);

  // 音频能力探测：面板打开/切歌时读一次在线配置与本地模型能力，供「听不到音频」提示。
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      getApiConfigs().catch(() => null),
      getLocalModelSettings().catch(() => null),
      getActiveLocalModel().catch(() => null),
    ]).then(([apiConfig, localSettings, localItem]) => {
      if (cancelled) return;
      const localMedia = getLocalModelMediaCapabilities(localSettings, localItem);
      setAudioSupported(resolveAudioSupport(apiConfig, localMedia));
    });
    return () => {
      cancelled = true;
    };
  }, [songId]);

  const generate = useCallback(async ({ kind, atMs = 0, note = '' }) => {
    const currentSong = songRef.current;
    if (!currentSong || generatingRef.current) return false;
    const character = (charactersRef.current || []).find(item => item.id === characterIdRef.current);
    if (!character) {
      setError(t('music.error.noCharacter'));
      return false;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    generatingRef.current = true;
    setGenerating(true);
    setError('');
    try {
      const [profile, presets, apiConfig, localSettings, localItem] = await Promise.all([
        getUserProfile().catch(() => null),
        getEnabledGlobalPresetPrompts().catch(() => []),
        getApiConfigs(),
        getLocalModelSettings().catch(() => null),
        getActiveLocalModel().catch(() => null),
      ]);
      if (controller.signal.aborted) return false;
      const localMedia = getLocalModelMediaCapabilities(localSettings, localItem);
      const canHear = resolveAudioSupport(apiConfig, localMedia);
      // 具备听音频能力时准备音频片段（默认从当前播放位置起 30 秒）；否则纯文字评论。
      const startMs = kind === 'opening' ? 0 : Math.max(0, Math.floor(Number(atMs)) || 0);
      const settings = clipSettingsRef.current || {};
      const songAudio = canHear
        ? await prepareSongAudioForModel(currentSong, clipAudioRef.current, {
          startMs,
          durationMs: Math.max(1, Math.floor(Number(settings.clipSeconds) || 0) * 1000) || CLIP_DURATION_MS,
          sampleRate: Math.max(1, Math.floor(Number(settings.sampleRate) || 0)) || CLIP_SAMPLE_RATE,
        })
        : null;
      if (controller.signal.aborted) return false;
      const withAudio = !!songAudio;
      const prompt = kind === 'opening'
        ? buildOpeningCommentPrompt({ songName: currentSong.name, durationMs: currentSong.durationMs, withAudio })
        : buildTriggerCommentPrompt({
          songName: currentSong.name,
          positionMs: atMs,
          durationMs: currentSong.durationMs,
          note,
          withAudio,
        });
      const requestMessages = buildRequestMessages({
        character,
        historyMessages: [],
        userText: prompt,
        userProfile: profile || {},
        globalPresets: presets,
        summaryText: '',
        memorySnippets: '',
        pluginContext: '',
        images: [],
        quote: null,
        voiceAudio: songAudio,
      });
      const activeConfig = apiConfig.configs.find(item => item.id === apiConfig.activeId)
        || apiConfig.configs[0];
      const expectedConfigId = String((activeConfig && activeConfig.id) || '');
      const expectedConfigFingerprint = activeConfig ? getConfigFingerprint(activeConfig) : '';
      // 本地路径：按本地模型能力裁剪媒体（音频）；在线路径：按在线配置能力裁剪。
      const localFileInfo = (localItem || localSettings)
        ? await getLocalModelFileInfo(localItem || localSettings).catch(() => null)
        : null;
      const localReady = canUseLocalModel(localSettings, localFileInfo, localItem);
      const localMessages = localReady
        ? filterRequestMedia(requestMessages, {
          allowVision: false,
          allowAudio: Boolean(localSettings && localSettings.enableMediaInput && localItem && localItem.hasAudio),
        })
        : requestMessages;
      const onlineMessages = filterRequestMedia(requestMessages, {
        allowVision: false,
        allowAudio: Boolean(activeConfig && activeConfig.supportsAudio),
      });
      const onlineSend = () => sendChatMessage(onlineMessages, {
        stream: false,
        signal: controller.signal,
        expectedConfigId,
        expectedConfigFingerprint,
      });
      const raw = await sendWithModelProvider({
        messages: localMessages,
        localSettings,
        localItem,
        localFileInfo,
        signal: controller.signal,
        conversationKey: `music:${String(currentSong.id || '')}`,
        onlineSend,
      });
      if (controller.signal.aborted) return false;
      // 接口空响应返回占位文本：那不是角色评论，按失败处理。
      const text = String(raw || '').trim();
      if (!text || text === EMPTY_REPLY_TEXT) throw new Error(t('error.comments.noReply'));
      const comment = {
        id: `c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        characterId: character.id,
        // 名字留空：显示层按当前语言补「角色」，切语言后旧评论也跟着变。
        characterName: String(character.name || '').trim(),
        text: text.slice(0, COMMENT_TEXT_MAX),
        atMs: kind === 'opening' ? 0 : Math.max(0, Math.floor(Number(atMs)) || 0),
        createdAt: Date.now(),
        source: kind === 'opening' ? 'opening' : 'trigger',
      };
      const next = await appendMusicComment(currentSong.id, comment);
      if (mountedRef.current && songRef.current && songRef.current.id === currentSong.id) {
        setComments(next);
      }
      lastFailedRef.current = null;
      return true;
    } catch (caught) {
      if (controller.signal.aborted || isCanceledError(caught)) return false;
      if (mountedRef.current) setError(t('music.comments.failed'));
      lastFailedRef.current = { kind, atMs, note };
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
    audioSupported,
  }), [comments, generating, error, characterId, generate, retry, audioSupported]);
}
