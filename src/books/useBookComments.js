// 一起看书的段落评论 hook：用户点「让TA聊聊这段」→ 取当前页文本摘录 → 组 prompt →
// 走与动态/听歌同款的 buildRequestMessages + sendChatMessage(stream:false) 链路
// （带 expectedConfig* 配置切换守卫）→ appendBookComment 落库。
// 评论只在面板内呈现、不进聊天会话（2026-10-03 用户裁决）；「接话」由界面层处理。
// 生成串行：同一时刻至多一次请求；换书即中断在途请求并装载新书的评论。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { EMPTY_REPLY_TEXT, getConfigFingerprint, isCanceledError, sendChatMessage } from '../network/api.js';
import { buildRequestMessages } from '../prompt/chatPipeline.js';
import {
  getApiConfigs,
  getEnabledGlobalPresetPrompts,
  getUserProfile,
} from '../storage.js';

import { appendBookComment, getBookComments } from './comments.js';
import { buildPassageCommentPrompt } from './commentPrompts.js';
import { useTranslation } from '../i18n/I18nContext.js';

const COMMENT_TEXT_MAX = 2000;

export function useBookComments({ book, characters, defaultCharacterId = '' }) {
  const [comments, setComments] = useState([]);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const [characterId, setCharacterId] = useState(String(defaultCharacterId || ''));
  const { t } = useTranslation();

  const bookRef = useRef(book);
  bookRef.current = book;
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

  // 换书：中断在途生成、重置错误与重试位，装载新书的评论。
  const bookId = book ? book.id : '';
  useEffect(() => {
    if (abortRef.current) abortRef.current.abort();
    setError('');
    lastFailedRef.current = null;
    setComments([]);
    if (!bookId) return undefined;
    let cancelled = false;
    getBookComments(bookId)
      .then(list => {
        if (!cancelled) setComments(list);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [bookId]);

  // request = { excerpt, chapterTitle, blockIndex, anchorText }，由界面从当前页取。
  const generate = useCallback(async request => {
    const currentBook = bookRef.current;
    const payload = request && typeof request === 'object' ? request : {};
    if (!currentBook || generatingRef.current) return false;
    const character = (charactersRef.current || []).find(item => item.id === characterIdRef.current);
    if (!character) {
      setError(t('books.error.noCharacter'));
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
      const prompt = buildPassageCommentPrompt({
        bookName: currentBook.name,
        chapterTitle: payload.chapterTitle,
        excerpt: payload.excerpt,
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
        id: `bc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        characterId: character.id,
        // 名字留空：显示层按当前语言补「角色」，切语言后旧评论也跟着变。
        characterName: String(character.name || '').trim(),
        text: text.slice(0, COMMENT_TEXT_MAX),
        anchor: {
          blockIndex: Math.max(0, Math.floor(Number(payload.blockIndex)) || 0),
          anchorText: String(payload.anchorText || '').slice(0, 400),
          excerpt: String(payload.excerpt || '').slice(0, 400),
        },
        chapterTitle: String(payload.chapterTitle || '').slice(0, 60),
        createdAt: Date.now(),
        source: 'manual',
      };
      const next = await appendBookComment(currentBook.id, comment);
      if (mountedRef.current && bookRef.current && bookRef.current.id === currentBook.id) {
        setComments(next);
      }
      lastFailedRef.current = null;
      return true;
    } catch (caught) {
      if (controller.signal.aborted || isCanceledError(caught)) return false;
      if (mountedRef.current) setError(t('books.comments.failed'));
      lastFailedRef.current = payload;
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
