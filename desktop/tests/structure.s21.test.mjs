// 桌面外壳结构守卫（S21）：按手机端路由/面板逐个核对后的差距清单。
//
// 这一轮换了个做法：不再只看「已知四项不可用」，而是把手机端的**全部导航注册点**
// 当权威清单（5 个 tab + 角色栈 2 + 扩展栈 15），逐个核对桌面是否有等价入口。
// 结论写在 MOBILE_SURFACE 表里，并且**这份表本身被断言覆盖**——路由漂移会先红。
//
// 本轮查出的真实缺口（旧注释把 extensions 设置节误当成顶栏「扩展」tab，导致整节漏掉）：
//   · 自动配图（inline image）：开关恒 false、气泡不渲染、场景转写逻辑只存在于手机
//     ChatScreen 的 useCallback 里；
//   · 表情包概率/位置：只有开关，没有档位与位置选择。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, '..');
const ROOT = path.resolve(DESKTOP, '..');
const read = (...parts) => readFileSync(path.join(DESKTOP, ...parts), 'utf8');
const readRoot = (...parts) => readFileSync(path.join(ROOT, ...parts), 'utf8');

// ---------------------------------------------------------------------------
// 差异清单：手机端每个可导航面 → 桌面等价物。
// status: 'done'   = 桌面有等价入口（值写明对应实现，下面会逐一断言存在）
//         'excluded' = 属用户明确排除的 agent 能力
//         'native'  = 依赖 Android 专属能力，桌面无等价物（已在 unsupportedReasons 留痕）
// ---------------------------------------------------------------------------
const MOBILE_SURFACE = Object.freeze([
  // 5 个 tab
  { mobile: 'tab:chat', status: 'done', desktop: 'src/provider/ChatPane.jsx' },
  { mobile: 'tab:memory', status: 'done', desktop: 'src/memory/MemoryListScreen.jsx' },
  { mobile: 'tab:character', status: 'done', desktop: 'src/character/CharacterLibraryScreen.jsx' },
  { mobile: 'tab:extension', status: 'done', desktop: 'src/extension/ExtensionScreen.jsx' },
  { mobile: 'tab:settings', status: 'done', desktop: 'src/settings/SettingsScreen.jsx' },
  // 角色栈
  { mobile: 'CharacterLibrary', status: 'done', desktop: 'src/character/CharacterLibraryScreen.jsx' },
  { mobile: 'CharacterDetail', status: 'done', desktop: 'src/character/CharacterEditScreen.jsx' },
  // 扩展栈：逐项（15 个 Stack.Screen）
  { mobile: 'ext-home', status: 'done', desktop: 'src/extension/ExtensionScreen.jsx' },
  { mobile: 'ext-forge', status: 'done', desktop: 'src/extension/screens/CardForgeScreen.jsx' },
  { mobile: 'ext-image', status: 'done', desktop: 'src/extension/screens/ImageGenScreen.jsx' },
  { mobile: 'ext-moments', status: 'done', desktop: 'src/extension/screens/MomentsScreen.jsx' },
  { mobile: 'ext-proactive', status: 'done', desktop: 'src/extension/screens/ProactiveScreen.jsx' },
  { mobile: 'ext-schedule', status: 'done', desktop: 'src/extension/screens/ScheduleScreen.jsx' },
  { mobile: 'ext-diary', status: 'done', desktop: 'src/extension/screens/DiaryScreen.jsx' },
  { mobile: 'ext-screen', status: 'done', desktop: 'src/extension/screens/ScreenWatchScreen.jsx' },
  { mobile: 'ext-plugins', status: 'done', desktop: 'src/extension/screens/PluginScreen.jsx' },
  { mobile: 'ext-music', status: 'done', desktop: 'src/extension/screens/MusicScreen.jsx' },
  { mobile: 'ext-books', status: 'done', desktop: 'src/extension/screens/BooksScreen.jsx' },
  { mobile: 'ext-map', status: 'done', desktop: 'src/extension/screens/MapScreen.jsx' },
  { mobile: 'ext-games', status: 'done', desktop: 'src/extension/screens/GamesScreen.jsx' },
  // 定时 Agent 任务：执行带工具循环的 agent，属排除范围。
  { mobile: 'ext-agent-task', status: 'excluded', reason: 'agent-tool-loop' },
]);

test('手机端导航注册点与差距清单一一对应（不漏项）', () => {
  const app = readRoot('App.js');
  const charStack = readRoot('src', 'character', 'CharacterStack.js');
  const extStack = readRoot('src', 'extension', 'ExtensionStack.js');

  const tabs = [...app.matchAll(/Tab\.Screen name=\{ROUTE_NAMES\.(\w+)\}/g)].map(m => `tab:${m[1]}`);
  assert.equal(tabs.length, 5, `手机端 tab 数量异常：${tabs.length}`);
  for (const tab of tabs) {
    assert.ok(MOBILE_SURFACE.some(item => item.mobile === tab), `差距清单缺 ${tab}`);
  }

  const charScreens = [...charStack.matchAll(/Stack\.Screen name="(\w+)"/g)].map(m => m[1]);
  for (const screen of charScreens) {
    assert.ok(MOBILE_SURFACE.some(item => item.mobile === screen), `差距清单缺角色栈 ${screen}`);
  }

  // 注意 ext-agent-task 含连字符：\w+ 会漏掉它（数量会少 1，清单也漏项）。
  const extScreens = [...extStack.matchAll(/Stack\.Screen name="(ext-[a-z-]+)"/g)].map(m => m[1]);
  assert.equal(extScreens.length, 14, `扩展栈注册数异常：${extScreens.length}`);
  for (const screen of extScreens) {
    assert.ok(MOBILE_SURFACE.some(item => item.mobile === screen), `差距清单缺扩展栈 ${screen}`);
  }
});

test('清单里标 done 的每一项，桌面文件都真实存在且非空壳', () => {
  for (const item of MOBILE_SURFACE.filter(entry => entry.status === 'done')) {
    const source = read(...item.desktop.split('/'));
    assert.ok(source.length > 400, `${item.mobile} → ${item.desktop} 像是空壳`);
    assert.ok(/return \(/.test(source) || /export default/.test(source),
      `${item.mobile} → ${item.desktop} 没有导出可渲染内容`);
  }
});

test('排除项只允许是 agent 工具域（不得把可移植项塞进 excluded）', () => {
  const excluded = MOBILE_SURFACE.filter(item => item.status === 'excluded');
  assert.deepEqual(excluded.map(item => item.mobile), ['ext-agent-task'],
    '排除项只应有定时 agent 任务');
  // 反证：它的执行体确实是 agent 循环。
  const runner = readRoot('src', 'agent', 'task', 'taskRunner.js');
  assert.ok(/runAgentTurn|listToolsForMode/.test(runner), '定时任务确实跑 agent 工具循环');
});

// ---------------------------------------------------------------------------
// 本轮补齐的缺口：自动配图 + 表情包档位
// ---------------------------------------------------------------------------
const HOOK = read('src', 'chat', 'useDesktopInlineImage.js');
const CARD = read('src', 'settings', 'InlineImageCard.jsx');
const ROW = read('src', 'render', 'MessageRow.jsx');
const CHAT = read('src', 'provider', 'useDesktopChat.js');
const PANE = read('src', 'provider', 'ChatPane.jsx');
const SHARED_PROMPT = readRoot('src', 'imageGen', 'inlineImagePrompt.js');

test('自动配图：场景转写抽到共享层，两端复用同一函数', () => {
  // 抽取后的共享编排存在，且是参数注入（不读 React/存储）。
  assert.ok(SHARED_PROMPT.includes('export async function resolveInlineImageSceneText'),
    '缺共享场景转写函数');
  assert.ok(SHARED_PROMPT.includes('sendScene'), '应支持注入模型调用（否则无法纯测）');
  assert.ok(!/from '.*react/.test(SHARED_PROMPT), '共用编排不得依赖 React');
  // 手机端也改用它构造的提示词 key（避免两端各写一句导致画面风格漂移）。
  const chatScreen = readRoot('src', 'ChatScreen.js');
  assert.ok(chatScreen.includes('chat.inlineImage.sceneSystemPrompt'),
    '手机端系统提示词也应走 i18n key');
});

test('自动配图：开关与生成入口接进共享 useChatSend 的两个 ref', () => {
  assert.ok(CHAT.includes('useDesktopInlineImage'), '聊天编排未接自动配图');
  assert.ok(/inlineImageEnabledRef\.current = inlineImage\.settings\.enabled/.test(CHAT),
    '开关必须来自设置（此前恒为 false）');
  assert.ok(/generateInlineImageRef\.current = inlineImage\.generateFor/.test(CHAT),
    '生成入口必须真接到共享链路');
  // 生成走共享 adjudication（prompt 组装 + 端点/解析），不自己拼请求。
  assert.ok(HOOK.includes('buildInlineImagePrompt'), '未复用共享提示词组接');
  assert.ok(HOOK.includes('generateImage'), '未复用共享生图执行器');
  assert.ok(HOOK.includes('resolveInlineImageSceneText'), '未复用共享场景转写');
  // 落盘走 documents/（渲染层只能经 easychat2-media:// 读这里）。
  assert.ok(HOOK.includes('markMediaWrite'), '缺媒体保护登记（孤儿回收会误删配图）');
});

test('自动配图：气泡三态渲染（loading / error+重试 / 图）', () => {
  for (const state of ['loading', 'error']) {
    assert.ok(ROW.includes(`status === '${state}'`), `缺 ${state} 态`);
  }
  assert.ok(ROW.includes('data-inline-image-state'), '缺可观测状态标记（冒烟/排查用）');
  assert.ok(ROW.includes('chat.bubble.inlineLoading'), '缺加载文案');
  assert.ok(ROW.includes('common.retry'), '失败态缺重试');
  assert.ok(ROW.includes('!isUser && message.inlineImage'), '配图只应出现在助手消息');
  assert.ok(PANE.includes('onGenerateImage'), '聊天页未把重试接到消息行');
});

test('设置页补齐内联配图与表情包档位（此前整节漏掉）', () => {
  assert.ok(CARD.includes('getInlineImageSettings'), '未读共享内联配图设置');
  assert.ok(CARD.includes('saveInlineImageSettings'), '未写共享内联配图设置');
  assert.ok(CARD.includes('INLINE_IMAGE_POSITIONS'), '缺位置选项（共享层唯一来源）');
  assert.ok(CARD.includes('normalizeStickerChance'), '表情包概率应走共享归一');
  assert.ok(CARD.includes('normalizeStickerPosition'), '表情包位置应走共享归一');
  assert.ok(CARD.includes('chat.sticker.title'), '表情包区块缺失');
  // 开启前必须校验供应商已配置：否则每条回复都会静默失败一次。
  assert.ok(CARD.includes('chat.inlineImage.noProvider.pick'), '缺「未选供应商」拦截');
  const settings = read('src', 'settings', 'SettingsScreen.jsx');
  assert.ok(settings.includes('InlineImageCard'), '设置页未挂载内联配图卡片');
});