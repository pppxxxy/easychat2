// 角色自己的动态下，用户评论后由发帖角色回复的那一条。
//
// 与 runUserMomentComments 同源（增值功能、失败静默、不写回会话/记忆），区别是这条
// 目标明确：只回应用户刚发的那一条评论，结果挂到它下面（replyToId = commentId）。
//
// 从 MomentsView 外提（2026-10-11）：原来这条回复挂在组件的 AbortController 上，
// 用户一退出动态页就被中止，评论石沉大海。现在交给模块级 runner 持有（见
// commentRunner.js），离开界面也会跑完并写库。
//
// 这里全部从存储读数据（角色卡 / 会话 / 预设 / 用户资料），不依赖 React 上下文，
// 因此可以在组件卸载后继续执行。
import { EMPTY_REPLY_TEXT, getConfigFingerprint, sendChatMessage } from '../network/api.js';
import { getApiConfigs } from '../storage/apiConfigs.js';
import { getCharacterLibrary } from '../storage/characters.js';
import { getEnabledGlobalPresetPrompts } from '../storage/globalPresets.js';
import { getMessagesBySession, getSessionSummaries, getSessions } from '../storage/sessions.js';
import { getMoments, updateMoments } from '../storage/moments.js';
import { getUserProfile } from '../storage/personas.js';
import { buildRequestMessages } from '../prompt/chatPipeline.js';
import { buildMomentMemoryText, buildMomentReplyPrompt, normalizeMomentReply } from './momentReply.js';
import { buildMemorySummaryText, isBuiltinAssistant, isSessionScopedMemory } from '../memory/memorySummary.js';

const inFlight = new Set();

function makeCommentId() {
  return `r-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

// 为「用户对角色动态的某条评论」生成角色的回复。返回写入的条数（0 或 1）。
// onComment 每写一条回调一次（界面据此刷新）；onError 在失败时回调（界面决定是否提示）。
export async function runCharacterMomentReply({
  momentId,
  commentId,
  signal = null,
  onComment = null,
  onError = null,
} = {}) {
  const id = String(momentId || '');
  const focusId = String(commentId || '');
  if (!id || !focusId || inFlight.has(id)) return 0;
  inFlight.add(id);
  const notifyError = error => {
    if (typeof onError !== 'function') return;
    try {
      onError(error);
    } catch (callbackError) {
      // 提示失败不该影响任务本身。
    }
  };
  try {
    const [moments, characters, profile, presets, apiConfig, sessions] = await Promise.all([
      getMoments().catch(() => []),
      getCharacterLibrary().catch(() => []),
      getUserProfile().catch(() => null),
      getEnabledGlobalPresetPrompts().catch(() => []),
      getApiConfigs(),
      getSessions().catch(() => []),
    ]);
    const moment = moments.find(item => item && item.id === id);
    if (!moment) return 0;
    const character = (Array.isArray(characters) ? characters : [])
      .find(item => item && String(item.id) === String(moment.characterId || ''));
    if (!character) {
      // 角色已不存在（通常动态也会被级联删除，这里兜底）。
      notifyError(new Error('moment-character-missing'));
      return 0;
    }
    const config = apiConfig.configs.find(item => item.id === apiConfig.activeId) || apiConfig.configs[0];
    if (!config) return 0;

    // 要回应的那条评论必须还在（用户可能已经删掉整条动态）。
    const comments = Array.isArray(moment.comments) ? moment.comments : [];
    if (!comments.some(item => item && String(item.id) === focusId)) return 0;

    const sessionId = String(moment.sessionId || '');
    const [summaries, messages] = await Promise.all([
      sessionId ? getSessionSummaries(sessionId).catch(() => []) : [],
      sessionId ? getMessagesBySession(sessionId).catch(() => []) : [],
    ]);
    if (signal && signal.aborted) return 0;

    const charName = String(moment.characterName || character.name || '').trim() || '角色';
    const userName = String((profile && profile.userName) || '').trim() || '用户';
    // 与聊天页同一口径：按“记忆是否按会话隔离”决定用会话摘要还是角色世界书记忆。
    // 内置助手按会话级；来源会话计入判定，避免把角色卡旧记忆带进来。
    const scoped = isBuiltinAssistant(character)
      || isSessionScopedMemory(sessions, character.id, undefined, sessionId);
    const memoryText = buildMemorySummaryText(character, summaries, scoped)
      || buildMomentMemoryText({ summaries, messages, charName, userName });
    const prompt = buildMomentReplyPrompt({
      moment,
      comments,
      memoryText,
      charName,
      userName,
      focusCommentId: focusId,
    });
    const requestMessages = buildRequestMessages({
      character,
      historyMessages: [],
      userText: prompt,
      userProfile: profile || {},
      globalPresets: presets,
      // 记忆已经在 prompt 里说明过一次，这里不再重复注入摘要
      summaryText: '',
      memorySnippets: '',
      pluginContext: '',
      images: [],
      quote: null,
    });

    let raw = '';
    try {
      raw = await sendChatMessage(requestMessages, {
        stream: false,
        signal,
        expectedConfigId: String(config.id || ''),
        expectedConfigFingerprint: getConfigFingerprint(config),
      });
    } catch (error) {
      if (!(signal && signal.aborted)) notifyError(error);
      return 0;
    }
    if (signal && signal.aborted) return 0;
    // 接口空响应会返回占位文本：那不是角色回复，不能写进动态。
    if (!raw || String(raw).trim() === EMPTY_REPLY_TEXT) {
      notifyError(new Error('moment-reply-empty'));
      return 0;
    }
    const text = normalizeMomentReply(raw);
    if (!text) {
      notifyError(new Error('moment-reply-empty'));
      return 0;
    }

    const comment = {
      id: makeCommentId(),
      by: 'character',
      characterId: String(character.id || ''),
      name: charName,
      text,
      createdAt: Date.now(),
      likedByCharacter: false,
      replyToId: focusId,
    };
    await updateMoments(list => list.map(item => (
      item.id === id
        ? { ...item, comments: [...(Array.isArray(item.comments) ? item.comments : []), comment] }
        : item
    )));
    if (typeof onComment === 'function') {
      try {
        onComment(comment);
      } catch (error) {
        // 纯 UI 通知，失败忽略。
      }
    }
    return 1;
  } catch (error) {
    notifyError(error);
    return 0;
  } finally {
    inFlight.delete(id);
  }
}
