// 用户发动态后的评论执行器：按「最活跃保底 + 随机」选出角色，串行生成评论。
//
// 设计约束：
// - 与同住反应一样，这是增值功能，绝不写回会话消息或记忆；失败静默；
// - 逐角色串行调用模型，合并进动态评论；每条动态同一时刻只跑一轮（防并发重复扣费）。
import { EMPTY_REPLY_TEXT, getConfigFingerprint, isCanceledError, sendChatMessage } from '../network/api.js';
import {
  getApiConfigs,
  getCharacterLibrary,
  getMessagesBySession,
  getMoments,
  getSessions,
  getUserProfile,
  updateMoments,
} from '../storage.js';
import {
  buildMomentMemoryText,
  buildMomentReplyPrompt,
  normalizeMomentReply,
} from './momentReply.js';
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

// 为一条用户动态生成 1~7 个角色的评论。返回写入的评论条数。
export async function runUserMomentComments({ momentId, signal = null, random = Math.random } = {}) {
  const id = String(momentId || '');
  if (!id || inFlight.has(id)) return 0;
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

    // 统计每个角色的消息总量：逐会话读取消息（串行，避免一次性并发大量读取）。
    const messageMap = {};
    for (const session of (Array.isArray(sessions) ? sessions : [])) {
      if (!session || String(session.type || 'single') === 'group') continue;
      if (!String(session.characterId || '')) continue;
      messageMap[session.id] = await getMessagesBySession(session.id).catch(() => []);
    }
    const totals = countCharacterMessageTotals(sessions, messageMap);

    const commenterIds = selectCommenters({
      characters,
      totals,
      // 用户自己发的动态，不排除任何角色；保留参数以便未来扩展（如排除发帖人）。
      excludeIds: [],
      random,
    });
    if (commenterIds.length === 0) return 0;

    const characterMap = new Map(
      (Array.isArray(characters) ? characters : []).map(item => [item.id, item])
    );
    const userName = String((profile && profile.userName) || '').trim() || '用户';

    // 评论串行生成：本轮里前面角色写的评论要进后面角色的提示词（thread 上下文）。
    // updateMoments 只更新存储，循环内不重读整个列表——这里本地累积，避免提示词里
    // 一直只有开跑前的旧评论。
    let threadComments = Array.isArray(moment.comments) ? moment.comments : [];

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
      const prompt = buildMomentReplyPrompt({
        moment,
        comments: threadComments,
        memoryText,
        charName,
        userName,
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
      const text = normalizeMomentReply(raw);
      if (!text) continue;
      const comment = {
        id: makeCommentId(),
        by: 'character',
        characterId: commenterId,
        name: charName,
        text,
        createdAt: Date.now(),
        likedByCharacter: false,
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
    }
    return written;
  } catch (error) {
    return written;
  } finally {
    inFlight.delete(id);
  }
}
