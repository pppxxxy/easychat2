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
    const config = configs.find(item => item.id === settings.apiConfigId)
      || configs.find(item => item.id === activeId)
      || configs[0];
    if (!config) {
      // 没有可用配置就只记录日期，避免每次启动都重扫。
      await saveDiarySettings(setDiaryLastRunDate(settings, dayKey));
      return 0;
    }

    const profile = await getUserProfile().catch(() => null);
    const userName = String((profile && profile.userName) || '').trim() || '用户';

    let nextSettings = settings;
    for (const role of roles) {
      const character = role.character;
      // 逐会话读取，只保留昨天窗口内的对话；没有对话就不写。
      const bySession = {};
      for (const sessionId of role.sessionIds) {
        bySession[sessionId] = await getMessagesBySession(sessionId).catch(() => []);
      }
      const windowMessages = collectWindowMessages(bySession, role.sessionIds, now);
      if (windowMessages.length === 0) continue;
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
        // 单个角色失败不影响其它角色，也不重试（下次启动会再试）。
        continue;
      }
      if (!raw || String(raw).trim() === EMPTY_REPLY_TEXT) continue;
      const text = normalizeDiaryText(raw);
      if (!text) continue;
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

    await saveDiarySettings(setDiaryLastRunDate(nextSettings, dayKey));
    return written;
  } catch (error) {
    // 静默失败：日记是增值功能，不能影响启动。
    return written;
  } finally {
    running = false;
  }
}
