// English locale.
//
// 迁移约定见 locales/zh-CN.js：只收 UI 文案，不含发给模型的提示词。
// 缺失的 key 会回退到中文（见 src/i18n/index.js 的 translate），因此这里按批次补齐即可。
// UI 框架文案可机翻后校对；涉及角色语气的文案（正在思考…、录音提示等）已人工润色。

// 2026-10-07 快赢3：词条按域拆分至 en/<域>.js（key 仍是平铺点分，这里按域
// 展开合并；新增域 = 新建域文件 + 在导出对象里补一行 ...<域>,）。对外导出面
// （en 命名导出 + default）不变，消费方与测试零改动。
import { apiPreset } from './en/apiPreset.js';
import { app } from './en/app.js';
import { agentTask } from './en/agentTask.js';
import { backup } from './en/backup.js';
import { books } from './en/books.js';
import { character } from './en/character.js';
import { chat } from './en/chat.js';
import { common } from './en/common.js';
import { dailyWife } from './en/dailyWife.js';
import { diagnostics } from './en/diagnostics.js';
import { diary } from './en/diary.js';
import { error } from './en/error.js';
import { ext } from './en/ext.js';
import { fontScale } from './en/fontScale.js';
import { forge } from './en/forge.js';
import { greetingPicker } from './en/greetingPicker.js';
import { group } from './en/group.js';
import { imageGen } from './en/imageGen.js';
import { localModel } from './en/localModel.js';
import { map } from './en/map.js';
import { memory } from './en/memory.js';
import { moments } from './en/moments.js';
import { music } from './en/music.js';
import { onboarding } from './en/onboarding.js';
import { plugin } from './en/plugin.js';
import { preset } from './en/preset.js';
import { proactive } from './en/proactive.js';
import { schedule } from './en/schedule.js';
import { screenWatch } from './en/screenWatch.js';
import { search } from './en/search.js';
import { security } from './en/security.js';
import { sessionRecovery } from './en/sessionRecovery.js';
import { settings } from './en/settings.js';
import { theme } from './en/theme.js';
import { transcription } from './en/transcription.js';
import { tts } from './en/tts.js';
import { tutorial } from './en/tutorial.js';
import { ui } from './en/ui.js';
import { vectorProvider } from './en/vectorProvider.js';
import { workspace } from './en/workspace.js';
import { world } from './en/world.js';
export const en = {
  ...apiPreset,
  ...app,
  ...agentTask,
  ...backup,
  ...books,
  ...character,
  ...chat,
  ...common,
  ...dailyWife,
  ...diagnostics,
  ...diary,
  ...error,
  ...ext,
  ...fontScale,
  ...forge,
  ...greetingPicker,
  ...group,
  ...imageGen,
  ...localModel,
  ...map,
  ...memory,
  ...moments,
  ...music,
  ...onboarding,
  ...plugin,
  ...preset,
  ...proactive,
  ...schedule,
  ...screenWatch,
  ...search,
  ...security,
  ...sessionRecovery,
  ...settings,
  ...theme,
  ...transcription,
  ...tts,
  ...tutorial,
  ...ui,
  ...vectorProvider,
  ...workspace,
  ...world,
};

export default en;
