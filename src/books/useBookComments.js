// 一起看书的段落评论 hook：用户点「让TA聊聊这段」→ 取当前页文本摘录 → 组 prompt →
// 走与动态/听歌同款的 buildRequestMessages + sendChatMessage(stream:false) 链路
// （带 expectedConfig* 配置切换守卫）→ appendBookComment 落库。
// 评论只在面板内呈现、不进聊天会话（2026-10-03 用户裁决）；「接话」由界面层处理。
// 生成串行：同一时刻至多一次请求；换书即中断在途请求并装载新书的评论。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { EMPTY_REPLY_TEXT, getConfigFingerprint, isCanceledError, sendChatMessage } from '../network/api.js';
import { buildRequestMessages } from '../prompt/chatPipeline.js';
import { getApiConfigs } from '../storage/apiConfigs.js';
import { getEnabledGlobalPresetPrompts } from '../storage/globalPresets.js';
import { getUserProfile } from '../storage/personas.js';

import { appendBookComment, getBookComments } from './comments.js';
import { buildPassageCommentPrompt } from './commentPrompts.js';
import { useTranslation } from '../i18n/I18nContext.js';

const COMMENT_TEXT_MAX = 2000;

export function useBookComments({ book, characters, defaultCharacterId = '' }) {
  const [comments, setComments] = useState([]);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  // 读路径（装载历史评论）的失败态，与生成失败**分开**记：两者的重试动作完全不同
  // （读失败 → 重新读盘；生成失败 → 重发请求），合成一个状态就分不清该重试什么。
  // 存布尔而不是文案：文案在返回时按当前语言现翻，切语言后错误条也跟着变
  //（存字符串会把切换那一刻的语言冻住）。
  const [commentsReadFailed, setCommentsReadFailed] = useState(false);
  const [characterId, setCharacterId] = useState(String(defaultCharacterId || ''));
  const { t } = useTranslation();

  const bookRef = useRef(book);
  bookRef.current = book;
  // 换书/装载的竞态判据：await 回来后用它确认「还是同一本书」，避免旧请求覆盖新书。
  const bookId = book ? book.id : '';
  const bookIdRef = useRef(bookId);
  bookIdRef.current = bookId;
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

  // 装载当前书的历史评论。读失败**不再吞掉**：以前 `.catch(() => {})` 把失败演成
  // 「空列表」，面板于是显示「还没有评论」，用户以为评论丢了（数据其实还在存储里）。
  // 现在把失败如实标出来（commentsReadFailed），并且**不清空已装载的评论**——读不到
  // 不等于没有；换书时才由下面的 effect 清空（那是「换了一本书」，不是「读失败」）。
  const loadComments = useCallback(async () => {
    const targetId = bookIdRef.current;
    if (!targetId) return false;
    try {
      const list = await getBookComments(targetId);
      // 装载期间换了书（或已卸载）：本次结果作废，effect 会为新书重新装载。
      if (!mountedRef.current || bookIdRef.current !== targetId) return false;
      setComments(list);
      setCommentsReadFailed(false);
      return true;
    } catch (caught) {
      if (!mountedRef.current || bookIdRef.current !== targetId) return false;
      setCommentsReadFailed(true);
      return false;
    }
  }, []);

  // 换书：中断在途生成、重置错误与重试位，装载新书的评论。
  useEffect(() => {
    if (abortRef.current) abortRef.current.abort();
    setError('');
    setCommentsReadFailed(false);
    lastFailedRef.current = null;
    setComments([]);
    if (!bookId) return undefined;
    loadComments();
    return undefined;
  }, [bookId, loadComments]);

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
      if (!text || text === EMPTY_REPLY_TEXT) throw new Error(t('error.comments.noReply'));
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
        // appendBookComment 是「读→写→回读」：它成功就说明读路径已经恢复，
        // 顺手清掉读失败标记，免得旧错误条赖着不走。
        setCommentsReadFailed(false);
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
    if (failed) return generate(failed);
    // 没有待重试的生成请求 → 这次错误条来自「读评论失败」，重试 = 重新读盘。
    if (commentsReadFailed) return loadComments();
    return Promise.resolve(false);
  }, [generate, loadComments, commentsReadFailed]);

  // 读失败要**并进 error** 才能被用户看见：消费面板（BookReaderView）的错误条只读 error，
  // 不合并的话读失败在界面上永远不显示；commentsError 另外单独透出，让调用方/测试能
  // 区分「读不到」与「生成失败」，也让重试走对的分支。
  const commentsError = commentsReadFailed ? t('books.comments.readFailed') : '';
  return useMemo(() => ({
    comments,
    generating,
    error: error || commentsError,
    commentsError,
    characterId,
    setCharacterId,
    generate,
    retry,
  }), [comments, generating, error, commentsError, characterId, generate, retry]);
}
