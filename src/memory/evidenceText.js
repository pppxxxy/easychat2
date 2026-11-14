// 记忆证据的正文脱敏：派生视图（溯源 / 合并来源）必须与聊天页**同源过滤**。
//
// 为什么单独成文件：这段逻辑原本定义在 memory/MemoryProvenanceModal.js（手机端 Modal，
// import 了 react-native 组件），桌面要用就得复制一份——而复制脱敏规则是隐私风险
// （一处漏改即泄漏）。抽成零依赖叶子后，两端调同一个函数。
//
// 背景（原注释保留）：聊天页渲染走 applyRegexScripts(..., { mode:'display' })，而角色卡
// 正则最常见的用途恰恰是隐藏/改写内容。派生视图若直接渲染 getMessagesBySessionStatus
// 读到的**原始** message.text，就是把「聊天页看不到的文字」在另一个界面全文复现
//（同仓脱敏纪律：secretStore.js:15-17、cardForge/preview.js:60-68）。
import { applyRegexScripts, REGEX_PLACEMENT } from '../prompt/regexEngine.js';
import { getCachedDisplayText } from './displayTextCache.js';

export { REGEX_PLACEMENT };

/** 角色消息按 AI 输出、用户消息按用户输入应用展示正则——与聊天页同一判定。 */
export function placementOfRole(role) {
  return role === 'assistant' ? REGEX_PLACEMENT.AI_OUTPUT : REGEX_PLACEMENT.USER_INPUT;
}

/**
 * 把一条消息的正文按角色卡正则脱敏后返回。
 * @param {object} item       消息（用 item.text）
 * @param {Array}  scripts    角色卡的 regexScripts
 * @param {string} placement  REGEX_PLACEMENT 值
 */
export function maskEvidenceText(item, scripts, placement) {
  return getCachedDisplayText(item, scripts, placement, 0, () => applyRegexScripts(
    String((item && item.text) || ''), scripts, placement, { mode: 'display', depth: 0 }
  ));
}

export default { maskEvidenceText, placementOfRole, REGEX_PLACEMENT };