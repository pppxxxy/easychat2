// 角色日记的启动执行器：过了一天之后的第一次启动时为符合条件的角色各写一篇日记。
// 设计上不弹 UI、不抛错给上层：后台任务失败只影响日记，不能拖垮启动。
import { EMPTY_REPLY_TEXT, sendChatMessage } from '../network/api.js';
import { recordDiagnostic } from '../storage/diagnostics.js';
import { getApiConfigs } from '../storage/apiConfigs.js';
import { getCharacterLibrary } from '../storage/characters.js';
import { getDiarySettings, saveDiarySettings, updateDiaries } from '../storage/diary.js';
import { getMessagesBySession, getSessions } from '../storage/sessions.js';
import { getUserProfile } from '../storage/personas.js';
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
  pickPrimarySession,
  selectDiaryRoles,
  selectWindowSessions,
  setDiaryLastRunDate,
  setDiaryLastRunSummary,
  shouldAdvanceDiaryRunDate,
} from './diary.js';

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
    // 运行结果计数（2026-10-07）：跳过/失败不再只进布尔量，写入设置摘要供面板
    // 显示「上次运行：日期｜写入/跳过/失败」，用户能区分「没触发」与「写了没写」。
    const outcome = { date: dayKey, written: 0, skipped: 0, failed: 0 };
    for (const role of roles) {
      const character = role.character;
      // 逐会话读取，只保留昨天窗口内的对话；没有对话就不写。
      const bySession = {};
      for (const sessionId of role.sessionIds) {
        bySession[sessionId] = await getMessagesBySession(sessionId).catch(() => []);
      }
      const windowMessages = collectWindowMessages(bySession, role.sessionIds, now);
      if (windowMessages.length === 0) {
        outcome.skipped += 1;
        continue;
      }
      // 归属（2026-10-07）：与 collectWindowMessages 共用同一窗口口径，算出本次
      // 实际贡献对话的会话列表与主会话（贡献消息最多者），随条目一起落盘。
      const contributingSessionIds = selectWindowSessions(bySession, role.sessionIds, now);
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
        // 单个角色失败不影响其它角色；计数失败以便同日再次触发时重试该角色。
        outcome.failed += 1;
        continue;
      }
      if (!raw || String(raw).trim() === EMPTY_REPLY_TEXT) {
        outcome.failed += 1;
        continue;
      }
      const text = normalizeDiaryText(raw);
      if (!text) {
        outcome.failed += 1;
        continue;
      }
      const entry = {
        id: `diary-${character.id}-${role.date}`,
        characterId: character.id,
        characterName: charName,
        date: role.date,
        text,
        createdAt: now,
        // 日记绑定历史对话：主会话 + 全部贡献会话（跨多段单聊时都记录）。
        sessionId: pickPrimarySession(bySession, contributingSessionIds, now),
        sourceSessionIds: contributingSessionIds,
      };
      await updateDiaries(list => appendDiary(list, entry));
      nextSettings = markRoleDiaryDate(nextSettings, character.id, role.date);
      outcome.written += 1;
      written += 1;
    }

    // 闸门推进规则（2026-10-07，纯函数 shouldAdvanceDiaryRunDate）：
    // 有候选角色就一律不推进——写入成功、失败、因昨天无对话跳过，都要保留当天
    // 再次触发的补写机会（回前台补跑靠它生效）。此前「纯跳过」也推进，会把当天
    // 吞掉：早上启动时昨天还没聊，当天再聊也不补写，必须等下一次跨天。
    const withSummary = setDiaryLastRunSummary(nextSettings, outcome);
    const finalSettings = shouldAdvanceDiaryRunDate({ roleCount: roles.length })
      ? setDiaryLastRunDate(withSummary, dayKey)
      : withSummary;
    await saveDiarySettings(finalSettings);
    // 运行结果进诊断（kind=startup 属既有白名单；内容仅计数与日期，无隐私文本）。
    // 面板状态行读设置里的 lastRun，诊断供排查用——用户终于能区分「没触发」与
    // 「触发了没写」。
    recordDiagnostic(
      'startup',
      { message: `diary run ${dayKey}: written=${outcome.written} skipped=${outcome.skipped} failed=${outcome.failed}` },
      'diary-run'
    );
    return written;
  } catch (error) {
    // 静默失败：日记是增值功能，不能影响启动。
    return written;
  } finally {
    running = false;
  }
}
