// 同住角色动态反应执行器：某角色发动态后，让同住一栋房子的其他角色来点赞、评论。
// 设计约束：
// - 这是增值功能，绝不写回会话消息或记忆；失败静默，不能拖垮发动态的主流程；
// - 逐角色串行调用模型，合并进动态列表；已反应过的角色不重复调用（不重复扣费）。
import { EMPTY_REPLY_TEXT, getConfigFingerprint, isCanceledError, sendChatMessage } from '../api.js';
import {
  getApiConfigs,
  getCharacterLibrary,
  getMoments,
  getWorldMap,
  updateMoments,
} from '../storage.js';
import { housemateCharacterIds, houseNumberLabel } from '../worldMap/map.js';
import {
  buildHousemateReactionPrompt,
  mergeReactionIntoMoments,
  parseHousemateReaction,
  selectReactingHousemates,
} from './housemateReactions.js';

// 每条动态同一时刻只跑一轮反应：避免并发重复调用模型（重复扣费）。
// 用集合而非全局锁，保证不同动态之间互不阻塞。
const inFlight = new Set();

// 角色的「性格设定」摘要：供提示词体现各自口吻。
function rolePersona(character) {
  const parts = [character.systemPrompt, character.description, character.personality, character.scenario]
    .map(item => String(item || '').trim())
    .filter(Boolean);
  return parts.join('；').slice(0, 300);
}

// 为一条动态生成同住角色的反应。返回本次新增的反应条数。
export async function runHousemateReactions({ momentId, signal = null } = {}) {
  const id = String(momentId || '');
  if (!id || inFlight.has(id)) return 0;
  inFlight.add(id);
  let written = 0;
  try {
    const [moments, characters, houses, apiConfig] = await Promise.all([
      getMoments().catch(() => []),
      getCharacterLibrary().catch(() => []),
      getWorldMap().catch(() => []),
      getApiConfigs(),
    ]);
    const moment = moments.find(item => item && item.id === id);
    if (!moment) return 0;
    const characterMap = new Map(
      (Array.isArray(characters) ? characters : []).map(item => [item.id, item])
    );
    const mateIds = housemateCharacterIds(houses, moment.characterId);
    const mates = mateIds
      .map(mateId => characterMap.get(mateId))
      .filter(Boolean)
      .map(character => ({
        id: character.id,
        name: String(character.name || '').trim() || '角色',
        persona: rolePersona(character),
      }));
    const pending = selectReactingHousemates({ reactors: mates, moment });
    if (pending.length === 0) return 0;

    const config = apiConfig.configs.find(item => item.id === apiConfig.activeId) || apiConfig.configs[0];
    if (!config) return 0;
    const sameHouseLabel = houseNumberLabel(
      houses.find(item => (
        (item.ownerType === 'character' && item.ownerId === moment.characterId)
        || (Array.isArray(item.residents) && item.residents.includes(moment.characterId))
      )),
      houses
    );
    const houseLabel = sameHouseLabel ? `${sameHouseLabel} 号房子` : '同一栋房子';

    for (const reactor of pending) {
      if (signal && signal.aborted) break;
      const prompt = buildHousemateReactionPrompt({
        moment,
        reactor,
        posterName: String(moment.characterName || '').trim() || '角色',
        charName: reactor.name,
        sameHouseLabel: houseLabel,
      });
      let raw = '';
      try {
        raw = await sendChatMessage([
          { role: 'system', content: `你是${reactor.name}，正在以这个身份刷社交动态。` },
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
      const parsed = parseHousemateReaction(raw);
      if (!parsed.like && !parsed.comment) continue;
      await updateMoments(list => mergeReactionIntoMoments(list, id, {
        characterId: reactor.id,
        name: reactor.name,
        like: parsed.like,
        comment: parsed.comment,
        createdAt: Date.now(),
      }));
      written += 1;
    }
    return written;
  } catch (error) {
    return written;
  } finally {
    inFlight.delete(id);
  }
}
