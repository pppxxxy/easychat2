// 制卡预览：把当前草稿整理成只读展示分区，并生成模拟对话的开场轮次。
// 与 UI 解耦的纯函数，便于单测；模拟对话本身走 chatPipeline 真实请求，不在这里。
import { applyRegexScripts, REGEX_PLACEMENT } from '../regexEngine.js';

const trim = value => String(value == null ? '' : value).trim();

// 模拟对话最多携带的历史轮数，避免长时间测试后上下文无限增长。
export const MAX_PREVIEW_TURNS = 24;

export function buildPreviewSections(draft) {
  const source = draft && typeof draft === 'object' ? draft : {};
  const rows = [
    ['描述', source.description],
    ['性格', source.personality],
    ['场景', source.scenario],
    ['系统提示', source.systemPrompt],
    ['对话示例', source.mesExample],
  ];
  return rows
    .map(([label, text]) => ({ label, text: trim(text) }))
    .filter(item => item.text);
}

// 开场白作为对话里的第一条角色消息；没有开场白时返回空，由界面提示用户直接发言。
export function buildPreviewOpeningTurns(draft, now = Date.now()) {
  const first = trim(draft && draft.firstMes);
  if (!first) return [];
  return [{ id: `preview-open-${now}`, role: 'assistant', text: first }];
}

export function capPreviewHistory(turns, limit = MAX_PREVIEW_TURNS) {
  const list = Array.isArray(turns) ? turns.filter(item => item && (item.role === 'user' || item.role === 'assistant')) : [];
  if (list.length <= limit) return list;
  return list.slice(list.length - limit);
}

export function previewAdvancedCounts(draft) {
  const source = draft && typeof draft === 'object' ? draft : {};
  const parts = [];
  if (Array.isArray(source.worldInfo) && source.worldInfo.length > 0) parts.push(`世界书 ${source.worldInfo.length}`);
  if (Array.isArray(source.regexScripts) && source.regexScripts.length > 0) parts.push(`正则 ${source.regexScripts.length}`);
  if (Array.isArray(source.presets) && source.presets.length > 0) parts.push(`预设 ${source.presets.length}`);
  return parts;
}

// 预览里的展示正则：与聊天页同一口径（mode: 'display'）。角色消息按 AI 输出、
// 用户消息按用户输入应用，让作者在预览里就能看到正则实际效果（高亮、去格式等）。
//
// 兜底：编辑器没有 placement 编辑入口，条目可能缺 placement 数组（AI 辅助合并、
// 旧卡、手改）——applyRegexScripts 遇到非数组会整条跳过，预览里就永远看不到效果。
// 这里补默认 [1,2] 并把 enabled 缺省视为开启，保证「写了正则就能在预览里看到」。
function normalizePreviewScript(script) {
  const source = script && typeof script === 'object' ? script : {};
  const placement = Array.isArray(source.placement) && source.placement.length > 0
    ? source.placement
    : [1, 2];
  return { ...source, placement, enabled: source.enabled !== false };
}

export function applyPreviewDisplay(text, regexScripts, role) {
  const scripts = (Array.isArray(regexScripts) ? regexScripts : []).map(normalizePreviewScript);
  const placement = role === 'user' ? REGEX_PLACEMENT.USER_INPUT : REGEX_PLACEMENT.AI_OUTPUT;
  try {
    return applyRegexScripts(trim(text), scripts, placement, { mode: 'display', depth: 0 });
  } catch (error) {
    return String(text == null ? '' : text);
  }
}

export function buildPreviewDisplayTurns(turns, draft) {
  const scripts = draft && Array.isArray(draft.regexScripts) ? draft.regexScripts : [];
  return (Array.isArray(turns) ? turns : []).map(turn => ({
    ...turn,
    display: applyPreviewDisplay(turn.text, scripts, turn.role),
  }));
}
