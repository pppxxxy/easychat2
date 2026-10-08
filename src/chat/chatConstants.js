// ChatScreen 的模块级常量。从 src/ChatScreen.js 原样外提（无行为变化）。

export const USER_ID = 'user';
export const ASSISTANT_ID = 'assistant';
export const SYSTEM_ERROR_ID = 'system-error';
// 聊天内工具调用的过程气泡（「正在搜索…」）：临时消息，不落库、不进上下文。
export const TOOL_BUBBLE_KIND = 'tool-bubble';
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

// 消息列表窗口化（MessageList 虚拟化）：默认只挂载尾部消息，扩窗逐步放开。
// INITIAL 为切会话/冷启动的初始窗口；STEP 为「加载更早消息」每次放开的条数；
// STEP_SCROLL 为 scrollToMessage 定位到窗口外消息时的一次扩窗量。
export const MESSAGE_WINDOW_INITIAL = 80;
export const MESSAGE_WINDOW_STEP = 200;
export const MESSAGE_WINDOW_STEP_SCROLL = 400;
