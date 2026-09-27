// 制卡预览：把当前草稿整理成只读展示分区，并生成模拟对话的开场轮次。
// 与 UI 解耦的纯函数，便于单测；模拟对话本身走 chatPipeline 真实请求，不在这里。
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
