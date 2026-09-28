// ChatScreen 的模块级常量。从 src/ChatScreen.js 原样外提（无行为变化）。

export const USER_ID = 'user';
export const ASSISTANT_ID = 'assistant';
export const SYSTEM_ERROR_ID = 'system-error';
export const THINKING_PLACEHOLDER = '正在思考...';
export const NEAR_BOTTOM_THRESHOLD = 80;
export const AI_DISCLAIMER_TEXT = 'AI 生成可能有误，仅供参考';
export const QUOTE_TEXT_MAX = 200;
export const INLINE_IMAGE_PROMPT_MAX = 400;

// 停止/失败时，若只生成了思考内容而没有正文，用这段文案替代占位符，
// 避免把“正在思考...”当作最终回复存下来。
export const NO_BODY_TEXT = '（未生成正文）';

export const THINKING_LEVEL_LABELS = { low: '低', medium: '中', high: '高' };
export const THINKING_DISPLAY_LABELS = { open: '开启', fold: '折叠', off: '关闭' };
