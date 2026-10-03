// 一起听歌的角色评论 hook：打点/开场触发 → 组 prompt → 走与动态同款的
// buildRequestMessages + sendChatMessage(stream:false) 链路 → appendMusicComment 落库。
// 评论只在面板内呈现、不进聊天会话（2026-10-03 用户裁决）；「接话」由界面层处理。
// 生成串行：同一时刻至多一次请求，新的触发在生成期间直接跳过（触发位已记 fired，
// 失败可从错误条重试，不会因跳过而永久丢失——重试走直调，不依赖 crossing）。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { EMPTY_REPLY_TEXT, getConfigFingerprint, isCanceledError, sendChatMessage } from '../api.js';
import { buildRequestMessages } from '../chatPipeline.js';
import {
  getApiConfigs,
  getEnabledGlobalPresetPrompts,
  getUserProfile,
} from '../storage.js';

import { appendMusicComment, getMusicComments } from './comments.js';
import { buildOpeningCommentPrompt, buildTriggerCommentPrompt } from './commentPrompts.js';

const COMMENT_TEXT_MAX = 2000;

export function useMusicComments({ song, characters, defaultCharacterId = '' }) {
  const [comments, setComments] = useState([]);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const [characterId, setCharacterId] = useState(String(defaultCharacterId || ''));

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

  const generate = useCallback(async ({ kind, atMs = 0, note = '' }) => {
    const currentSong = songRef.current;
    if (!currentSong || generatingRef.current) return false;
    const character = (charactersRef.current || []).find(item => item.id === characterIdRef.current);
    if (!character) {
      setError('请先选择一位一起听歌的角色');
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
      const prompt = kind === 'opening'
        ? buildOpeningCommentPrompt({ songName: currentSong.name, durationMs: currentSong.durationMs })
        : buildTriggerCommentPrompt({
          songName: currentSong.name,
          positionMs: atMs,
          durationMs: currentSong.durationMs,
          note,
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
        characterName: String(character.name || '').trim() || '角色',
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
      if (mountedRef.current) setError('评论生成失败，请检查 API 配置后重试。');
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
  }), [comments, generating, error, characterId, generate, retry]);
}
