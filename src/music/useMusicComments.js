// 一起听歌的角色评论 hook：打点/开场触发 → 组 prompt → 走与动态同款的
// buildRequestMessages + sendChatMessage(stream:false) 链路 → appendMusicComment 落库。
// 评论只在面板内呈现、不进聊天会话（2026-10-03 用户裁决）；「接话」由界面层处理。
// 生成串行：同一时刻至多一次请求，新的触发在生成期间直接跳过（触发位已记 fired，
// 失败可从错误条重试，不会因跳过而永久丢失——重试走直调，不依赖 crossing）。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as FileSystem from 'expo-file-system/legacy';

import { EMPTY_REPLY_TEXT, getConfigFingerprint, isCanceledError, sendChatMessage } from '../network/api.js';
import { buildRequestMessages } from '../prompt/chatPipeline.js';
import {
  getApiConfigs,
  getEnabledGlobalPresetPrompts,
  getUserProfile,
} from '../storage.js';

import { appendMusicComment, getMusicComments } from './comments.js';
import {
  buildOpeningCommentPrompt,
  buildTriggerCommentPrompt,
  canAttachSongAudio,
  resolveAudioSupport,
} from './commentPrompts.js';
import { useTranslation } from '../i18n/I18nContext.js';

const COMMENT_TEXT_MAX = 2000;

// 读取歌曲文件为 base64，供多模态模型「听」。超过体积上限或读盘失败返回 null，
// 调用方退回纯文字评论（不阻断功能）。mime 空时交给 resolveVoiceFormat 兜底。
export async function readSongAudioForModel(currentSong) {
  const song = currentSong && typeof currentSong === 'object' ? currentSong : {};
  if (!canAttachSongAudio(song)) return null;
  try {
    const base64 = await FileSystem.readAsStringAsync(song.uri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    if (!base64) return null;
    return { base64, mime: String(song.mime || '').trim() };
  } catch (error) {
    return null;
  }
}

export function useMusicComments({ song, characters, defaultCharacterId = '' }) {
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

  // 音频能力探测：面板打开/切歌时读一次在线配置，供「听不到音频」提示。
  useEffect(() => {
    let cancelled = false;
    getApiConfigs()
      .catch(() => null)
      .then(apiConfig => {
        if (cancelled) return;
        setAudioSupported(resolveAudioSupport(apiConfig));
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
      const [profile, presets, apiConfig] = await Promise.all([
        getUserProfile().catch(() => null),
        getEnabledGlobalPresetPrompts().catch(() => []),
        getApiConfigs(),
      ]);
      if (controller.signal.aborted) return false;
      const canHear = resolveAudioSupport(apiConfig);
      // 具备听音频能力时把整首歌随消息发给模型（多模态）；否则纯文字评论。
      const songAudio = canHear ? await readSongAudioForModel(currentSong) : null;
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
      const raw = await sendChatMessage(requestMessages, {
        stream: false,
        signal: controller.signal,
        expectedConfigId: String((activeConfig && activeConfig.id) || ''),
        expectedConfigFingerprint: activeConfig ? getConfigFingerprint(activeConfig) : '',
      });
      if (controller.signal.aborted) return false;
      // 接口空响应返回占位文本：那不是角色评论，按失败处理。
      const text = String(raw || '').trim();
      if (!text || text === EMPTY_REPLY_TEXT) throw new Error('没有收到回复内容');
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
