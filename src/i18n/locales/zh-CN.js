// 国际化词条表（简体中文 = 基准语言）。
//
// 约定：
// - key 用「域.语义」的点分命名（app.tab.chat / chat.attach.title），便于按域分批迁移；
// - 中文是基准：其余语言缺某个 key 时回退到中文，界面不会出现空白文案；
// - **只收 UI 文案**。发给模型的提示词（src/presets.js、src/cardForge/forge.js、
//   src/moments/affinity.js、src/memory/memorySummary.js 等）不在此列——翻译它们会改变
//   角色行为，中文对话场景下英文关键词表会直接失灵；
// - 本文件随迁移批次增长，不要求一次补全。

// 2026-10-07 快赢3：词条按域拆分至 zh-CN/<域>.js（key 仍是平铺点分，这里按域
// 展开合并；新增域 = 新建域文件 + 在导出对象里补一行 ...<域>,）。对外导出面
// （zhCN 命名导出 + default）不变，消费方与测试零改动。
import { apiPreset } from './zh-CN/apiPreset.js';
import { app } from './zh-CN/app.js';
import { agentTask } from './zh-CN/agentTask.js';
import { backup } from './zh-CN/backup.js';
import { books } from './zh-CN/books.js';
import { character } from './zh-CN/character.js';
import { chat } from './zh-CN/chat.js';
import { common } from './zh-CN/common.js';
import { dailyWife } from './zh-CN/dailyWife.js';
import { diagnostics } from './zh-CN/diagnostics.js';
import { diary } from './zh-CN/diary.js';
import { error } from './zh-CN/error.js';
import { ext } from './zh-CN/ext.js';
import { fontScale } from './zh-CN/fontScale.js';
import { forge } from './zh-CN/forge.js';
import { greetingPicker } from './zh-CN/greetingPicker.js';
import { group } from './zh-CN/group.js';
import { imageGen } from './zh-CN/imageGen.js';
import { localModel } from './zh-CN/localModel.js';
import { map } from './zh-CN/map.js';
import { memory } from './zh-CN/memory.js';
import { moments } from './zh-CN/moments.js';
import { music } from './zh-CN/music.js';
import { onboarding } from './zh-CN/onboarding.js';
import { plugin } from './zh-CN/plugin.js';
import { preset } from './zh-CN/preset.js';
import { proactive } from './zh-CN/proactive.js';
import { schedule } from './zh-CN/schedule.js';
import { screenWatch } from './zh-CN/screenWatch.js';
import { search } from './zh-CN/search.js';
import { security } from './zh-CN/security.js';
import { sessionRecovery } from './zh-CN/sessionRecovery.js';
import { settings } from './zh-CN/settings.js';
import { theme } from './zh-CN/theme.js';
import { transcription } from './zh-CN/transcription.js';
import { tts } from './zh-CN/tts.js';
import { tutorial } from './zh-CN/tutorial.js';
import { ui } from './zh-CN/ui.js';
import { vectorProvider } from './zh-CN/vectorProvider.js';
import { workspace } from './zh-CN/workspace.js';
import { world } from './zh-CN/world.js';
export const zhCN = {
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

export default zhCN;
