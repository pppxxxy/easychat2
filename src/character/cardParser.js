// 角色卡解析：JSON / PNG → 应用内部卡片形态。纯函数（除 i18n 取词外无副作用）。
//
// 对外 barrel：实现已按职责拆到 ./cardParser/*.js（本文件只做转发，既有导入方零改动）：
//   ./cardParser/normalizeUtils.js 容错取值小工具
//   ./cardParser/worldInfo.js      世界书条目归一
//   ./cardParser/regexScripts.js   正则脚本归一
//   ./cardParser/standardFields.js 标准字段抽取 + 系统提示词拼装
//   ./cardParser/normalizeCard.js  整卡归一（保留未消费字段）
//   ./cardParser/json.js           JSON 文本清洗与解析
//   ./cardParser/png.js            PNG 角色卡读取（parsecard + 手解回退）

export { buildSystemPrompt } from './cardParser/standardFields.js';
export { ensureUniqueIds, normalizeCard } from './cardParser/normalizeCard.js';
export { parseCardFromJson } from './cardParser/json.js';
export { parseCardFromPng, readCardJsonFromPng } from './cardParser/png.js';
export { createWorldEntry, WORLD_POSITION_LABELS } from './cardParser/worldInfo.js';
export { createRegexScript, REGEX_PLACEMENT_LABELS } from './cardParser/regexScripts.js';
