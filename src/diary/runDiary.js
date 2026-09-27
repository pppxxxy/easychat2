// 角色日记的启动执行器：过了一天之后的第一次启动时为符合条件的角色各写一篇日记。
// 设计上不弹 UI、不抛错给上层：后台任务失败只影响日记，不能拖垮启动。
import { EMPTY_REPLY_TEXT, sendChatMessage } from '../api';
import {
  getApiConfigs,
  getCharacterLibrary,
  getDiarySettings,
  getMessagesBySession,
  getSessions,
  getUserProfile,
  saveDiarySettings,
  updateDiaries,
} from '../storage';
import {
  appendDiary,
  buildDiaryPrompt,
  buildDiaryTranscript,
  collectWindowMessages,
  isNewDay,
  localDateKey,
  markRoleDiaryDate,
  normalizeDiaryText,
  resolveRoleDiaryConfigId,
  selectDiaryRoles,
  setDiaryLastRunDate,
} from './diary';

let running = false;

// 返回本次实际写入的日记条数，便于调用方（或测试）观察。
export async function runDiaryForNewDay({ now = Date.now() } = {}) {
  if (running) return 0;
  running = true;
  let written = 0;
  try {
    const settings = await getDiarySettings();
    // 闸门：同一天的多次启动只执行一次。
    if (!isNewDay(settings.lastRunDate, now)) return 0;
    const dayKey = localDateKey(now);

    const [characters, sessions] = await Promise.all([
      getCharacterLibrary().catch(() => []),
      getSessions().catch(() => []),
    ]);
    const roles = selectDiaryRoles({ characters, settings, sessions, now });
    if (roles.length === 0) {
      await saveDiarySettings(setDiaryLastRunDate(settings, dayKey));
      return 0;
    }

    const { configs, activeId } = await getApiConfigs();
    if (configs.length === 0) {
      // 没有可用配置：不推进全局日期，等用户配好 API 后同日再启动仍可补写。
      return 0;
    }
    const defaultConfig = configs.find(item => item.id === settings.apiConfigId)
      || configs.find(item => item.id === activeId)
      || configs[0];

    const profile = await getUserProfile().catch(() => null);
    const userName = String((profile && profile.userName) || '').trim() || '用户';

    let nextSettings = settings;
    let hadFailure = false;
    for (const role of roles) {
      const character = role.character;
      // 逐会话读取，只保留昨天窗口内的对话；没有对话就不写。
      const bySession = {};
      for (const sessionId of role.sessionIds) {
        bySession[sessionId] = await getMessagesBySession(sessionId).catch(() => []);
      }
      const windowMessages = collectWindowMessages(bySession, role.sessionIds, now);
      if (windowMessages.length === 0) continue;
      // 每角色可单独指定写日记的 API；未指定时回退全局/当前激活配置。
      const roleConfigId = resolveRoleDiaryConfigId(settings, character.id);
      const config = configs.find(item => item.id === roleConfigId) || defaultConfig;
      const charName = String(character.name || '').trim() || '角色';
      const transcript = buildDiaryTranscript(windowMessages, { charName, userName });
      const prompt = buildDiaryPrompt({ charName, userName, transcript, date: role.date });
      let raw = '';
      try {
        raw = await sendChatMessage([
          { role: 'system', content: `你是${charName}，正在写自己的私人日记。` },
          { role: 'user', content: prompt },
        ], {
          stream: false,
          configId: String(config.id || ''),
          model: String(settings.model || '').trim() || undefined,
        });
      } catch (error) {
        // 单个角色失败不影响其它角色；标记失败以便同日再次启动重试该角色。
        hadFailure = true;
        continue;
      }
      if (!raw || String(raw).trim() === EMPTY_REPLY_TEXT) {
        hadFailure = true;
        continue;
      }
      const text = normalizeDiaryText(raw);
      if (!text) {
        hadFailure = true;
        continue;
      }
      const entry = {
        id: `diary-${character.id}-${role.date}`,
        characterId: character.id,
        characterName: charName,
        date: role.date,
        text,
        createdAt: now,
      };
      await updateDiaries(list => appendDiary(list, entry));
      nextSettings = markRoleDiaryDate(nextSettings, character.id, role.date);
      written += 1;
    }

    // 有角色失败就不推进「上次运行日期」：同日再次启动会重扫，已成功的角色由各自
    // 的 lastDiaryDate 跳过，失败的角色得以补写；否则跨天后窗口前移就永久缺失。
    const finalSettings = hadFailure
      ? nextSettings
      : setDiaryLastRunDate(nextSettings, dayKey);
    await saveDiarySettings(finalSettings);
    return written;
  } catch (error) {
    // 静默失败：日记是增值功能，不能影响启动。
    return written;
  } finally {
    running = false;
  }
}
