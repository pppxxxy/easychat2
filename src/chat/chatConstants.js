// ChatScreen 的模块级常量。从 src/ChatScreen.js 原样外提（无行为变化）。

export const USER_ID = 'user';
export const ASSISTANT_ID = 'assistant';
export const SYSTEM_ERROR_ID = 'system-error';
// 聊天内工具调用的过程气泡（「正在搜索…」）：临时消息，不落库、不进上下文。
export const TOOL_BUBBLE_KIND = 'tool-bubble';
export const NEAR_BOTTOM_THRESHOLD = 80;
export const QUOTE_TEXT_MAX = 200;
export const INLINE_IMAGE_PROMPT_MAX = 400;
// 用户可见文案：这里**只放 i18n key**，不放任何中文字面量。
// 背景：模块级导出的字符串常量会被渲染层直接读走，既绕过 no-hardcoded-chinese
// （首版只查 Alert/throw 的直接参数），也永远不随语言切换更新。改成 key 之后，
// 取值一律经 t(key)，语言切换由 I18nProvider 的重渲染负责。
export const THINKING_PLACEHOLDER_KEY = 'chat.thinking.placeholder';
export const AI_DISCLAIMER_TEXT_KEY = 'chat.aiDisclaimer';
export const NO_BODY_TEXT_KEY = 'chat.noBody';
export const THINKING_LEVEL_KEYS = { low: 'chat.thinking.level.low', medium: 'chat.thinking.level.medium', high: 'chat.thinking.level.high' };
export const THINKING_DISPLAY_KEYS = { open: 'chat.thinking.display.open', fold: 'chat.thinking.display.fold', off: 'chat.thinking.display.off' };

// 「这条消息的 text 还是思考占位符吗」：占位符随语言变，比较必须用**同一个 t**
// （不能拿旧的中文常量去比——英文界面下永远不相等，会把占位符当正文存下来）。
// 占位符只存在于 pending 期间（首个 token 落地即被覆写），不存在跨语言残留的持久化消息。
export const isThinkingPlaceholder = (text, t) => (
  typeof text === 'string'
  && typeof t === 'function'
  && text.length > 0
  && text === t(THINKING_PLACEHOLDER_KEY)
);

// 消息列表窗口化（MessageList 虚拟化）：默认只挂载尾部消息，扩窗逐步放开。
// INITIAL 为切会话/冷启动的初始窗口；STEP 为「加载更早消息」每次放开的条数；
// STEP_SCROLL 为 scrollToMessage 定位到窗口外消息时的一次扩窗量。
export const MESSAGE_WINDOW_INITIAL = 80;
export const MESSAGE_WINDOW_STEP = 200;
export const MESSAGE_WINDOW_STEP_SCROLL = 400;

// FlatList 虚拟化参数（MessageList）。窗口化（上面的 MESSAGE_WINDOW_*）与虚拟化是两层：
// 窗口决定「哪些消息在数据里」，虚拟化决定「数据里哪些真的挂载」。
// - INITIAL_RENDER：首屏批次。框架把这一批**始终保留**在渲染遮罩里
//   （VirtualizedList._createRenderMask：「The initially rendered cells are retained as
//   part of the scroll-to-top optimization」），所以它是一笔常驻开销，不该等于窗口大小
//   ——那会让整个窗口永远挂载、虚拟化形同虚设。取框架默认值 10：常驻 10 条，
//   其余全靠渲染窗口。
// - RENDER_WINDOW：以「视口高度」为单位的渲染窗口（框架默认 21 = 上下各约 10 屏）。
//   消息气泡里可能有图片与 WebView 富文本，收到 11（上下各约 5 屏）。
//   实测（用框架自己的 computeWindowedRenderLimits，见提交说明）：停在底部时挂载约 50 条、
//   停在长列表中段时约 98 条，与窗口大小无关。
export const MESSAGE_LIST_INITIAL_RENDER = 10;
export const MESSAGE_LIST_RENDER_WINDOW = 11;
