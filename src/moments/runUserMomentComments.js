// 用户发动态后的评论执行器：按「最活跃保底 + 随机」选出角色，串行生成评论。
//
// 设计约束：
// - 与同住反应一样，这是增值功能，绝不写回会话消息或记忆；失败静默；
// - 逐角色串行调用模型，合并进动态评论；每条动态同一时刻只跑一轮（防并发重复扣费）。
import { EMPTY_REPLY_TEXT, getConfigFingerprint, isCanceledError, sendChatMessage } from '../network/api.js';
import { getApiConfigs } from '../storage/apiConfigs.js';
import { getCharacterLibrary } from '../storage/characters.js';
import { getMessagesBySession, getSessions } from '../storage/sessions.js';
import { getMoments, updateMoments } from '../storage/moments.js';
import { getUserProfile } from '../storage/personas.js';
import {
  buildMomentCommentPrompt,
  buildMomentMemoryText,
  normalizeMomentReply,
} from './momentReply.js';
import { parseCommentReplyTarget } from './commentThread.js';
import {
  countCharacterMessageTotals,
  selectCommenters,
} from './commenters.js';

const inFlight = new Set();

function rolePersona(character) {
  const parts = [character.systemPrompt, character.description, character.personality, character.scenario]
    .map(item => String(item || '').trim())
    .filter(Boolean);
  return parts.join('；').slice(0, 300);
}

function makeCommentId() {
  return `r-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

// 为一条用户动态生成评论。返回写入的评论条数。
//
// 两种模式：
// - 'post'（默认）：用户刚发了动态，选「最活跃保底 + 随机」的角色各写一条评论，
//   重点是回应用户本人；模型可用「回复<名字>：」前缀把某条评论变成对它的回复。
// - 'reply'：用户对着某条评论做了回应，只让被回应的那个角色（responderIds）来回应，
//   结果固定挂在那条用户评论下（replyToId = focusCommentId）。
export async function runUserMomentComments({
  momentId,
  signal = null,
  random = Math.random,
  mode = 'post',
  focusCommentId = '',
  responderIds = null,
  onComment = null,
} = {}) {
  const id = String(momentId || '');
  if (!id || inFlight.has(id)) return 0;
  const replyMode = String(mode || 'post') === 'reply';
  inFlight.add(id);
  let written = 0;
  try {
    const [moments, characters, sessions, apiConfig, profile] = await Promise.all([
      getMoments().catch(() => []),
      getCharacterLibrary().catch(() => []),
      getSessions().catch(() => []),
      getApiConfigs(),
      getUserProfile().catch(() => null),
    ]);
    const moment = moments.find(item => item && item.id === id);
    if (!moment) return 0;

    const config = apiConfig.configs.find(item => item.id === apiConfig.activeId) || apiConfig.configs[0];
    if (!config) return 0;

    const characterMap = new Map(
      (Array.isArray(characters) ? characters : []).map(item => [item.id, item])
    );

    let commenterIds;
    if (replyMode) {
      // 只让被回应的角色出场；去重并过滤掉已不存在的角色。
      commenterIds = [...new Set((Array.isArray(responderIds) ? responderIds : [])
        .map(value => String(value || ''))
        .filter(Boolean))]
        .filter(characterId => characterMap.has(characterId));
    } else {
      // 统计每个角色的消息总量：逐会话读取消息（串行，避免一次性并发大量读取）。
      const messageMap = {};
      for (const session of (Array.isArray(sessions) ? sessions : [])) {
        if (!session || String(session.type || 'single') === 'group') continue;
        if (!String(session.characterId || '')) continue;
        messageMap[session.id] = await getMessagesBySession(session.id).catch(() => []);
      }
      const totals = countCharacterMessageTotals(sessions, messageMap);
      commenterIds = selectCommenters({
        characters,
        totals,
        // 用户自己发的动态，不排除任何角色；保留参数以便未来扩展（如排除发帖人）。
        excludeIds: [],
        random,
      });
    }
    if (commenterIds.length === 0) return 0;

    const userName = String((profile && profile.userName) || '').trim() || '用户';

    // 评论串行生成：本轮里前面角色写的评论要进后面角色的提示词（thread 上下文）。
    // updateMoments 只更新存储，循环内不重读整个列表——这里本地累积，避免提示词里
    // 一直只有开跑前的旧评论。
    let threadComments = Array.isArray(moment.comments) ? moment.comments : [];
    const focusId = String(focusCommentId || '');
    const focusExists = replyMode && threadComments.some(item => item && String(item.id) === focusId);

    for (const commenterId of commenterIds) {
      if (signal && signal.aborted) break;
      const character = characterMap.get(commenterId);
      if (!character) continue;
      const charName = String(character.name || '').trim() || '角色';
      const memoryText = buildMomentMemoryText({
        summaries: [],
        messages: [],
        charName,
        userName,
      }) || rolePersona(character);
      const prompt = buildMomentCommentPrompt({
        moment,
        comments: threadComments,
        memoryText,
        charName,
        userName,
        focusCommentId: focusExists ? focusId : '',
      });
      let raw = '';
      try {
        raw = await sendChatMessage([
          { role: 'system', content: `你是${charName}，正在以这个身份刷社交动态。` },
          { role: 'user', content: prompt },
        ], {
          stream: false,
          signal,
          expectedConfigId: String(config.id || ''),
          expectedConfigFingerprint: getConfigFingerprint(config),
        });
      } catch (error) {
        if (isCanceledError(error)) break;
        continue;
      }
      if (signal && signal.aborted) break;
      if (!raw || String(raw).trim() === EMPTY_REPLY_TEXT) continue;
      // 回复轮：整轮就是冲着那条用户评论来的，固定挂靠；发帖轮则看模型有没有写
      // 「回复<名字>：」前缀，没有就当作对动态本身的顶层评论。
      const parsed = focusExists
        ? { text: normalizeMomentReply(raw), replyToId: focusId }
        : (() => {
          const target = parseCommentReplyTarget(raw, threadComments);
          return { text: normalizeMomentReply(target.text), replyToId: target.replyToId };
        })();
      const text = parsed.text;
      if (!text) continue;
      const comment = {
        id: makeCommentId(),
        by: 'character',
        characterId: commenterId,
        name: charName,
        text,
        createdAt: Date.now(),
        likedByCharacter: false,
        ...(parsed.replyToId ? { replyToId: parsed.replyToId } : {}),
      };
      await updateMoments(list => list.map(item => (
        item.id === id
          ? {
            ...item,
            comments: [
              ...(Array.isArray(item.comments) ? item.comments : []),
              comment,
            ],
          }
          : item
      )));
      threadComments = [...threadComments, comment];
      written += 1;
      // 每写一条就回调一次：界面据此刷新，让评论一条条出现（回调抛错不影响本轮）。
      if (typeof onComment === 'function') {
        try {
          onComment(comment);
        } catch (error) {
          // 忽略：这是纯 UI 通知。
        }
      }
    }
    return written;
  } catch (error) {
    return written;
  } finally {
    inFlight.delete(id);
  }
}
