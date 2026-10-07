// 「从对话生成角色卡」UI 接线结构守卫。项目无 React 渲染器，按既有约定用源码
// 锚点验证接线与约束。重点四条：
//   1) 打开面板不发请求（生成要花钱，必须用户点）；
//   2) 素材按会话顺序取，不是点击顺序；
//   3) 保存前过 hasCardContent，模型给空壳时不落库；
//   4) 系统提示词/采样参数与制卡页共用一份，不在两处各写一遍。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = rel => readFileSync(path.join(HERE, '..', rel), 'utf8');

const CHAT_SCREEN = read('src/ChatScreen.js');
const TOP_BAR = read('src/chat/ChatTopBar.js');
const MODAL = read('src/chat/ConversationCardModal.js');
const FORGE_SCREEN = read('src/CardForgeScreen.js');
const SHARED = read('src/cardForge/forge/shared.js');
const ZH = read('src/i18n/locales/zh-CN/chat.js');
const EN = read('src/i18n/locales/en/chat.js');

test('多选顶栏：只有传了回调才渲染「角色卡」，发送中禁用', () => {
  assert.ok(TOP_BAR.includes('onForgeCard'));
  assert.ok(TOP_BAR.includes("typeof onForgeCard === 'function'"), '未接线时不渲染，避免出现点了没反应的按钮');
  assert.ok(TOP_BAR.includes('onPress={onForgeCard}'));
  assert.ok(TOP_BAR.includes("t('chat.topBar.selection.forgeCard')"));
  assert.ok(TOP_BAR.includes("t('chat.topBar.a11y.forgeCard')"));
  assert.ok(TOP_BAR.includes('disabled={isSending}'), '发送中不可点');
});

test('ChatScreen：素材按会话顺序取选中消息，并挂上生成面板', () => {
  assert.ok(CHAT_SCREEN.includes("import ConversationCardModal from './chat/ConversationCardModal.js';"));
  assert.ok(CHAT_SCREEN.includes('const selectedMessagesForCard = useMemo('));
  // 过滤 messages 而不是遍历 selectedMessageIds：前者天然保持会话先后顺序
  assert.ok(
    CHAT_SCREEN.includes('selectedMessageIdSet.has(String(item.id))'),
    '按选中集合过滤 messages，顺序即会话顺序'
  );
  assert.ok(CHAT_SCREEN.includes('onForgeCard={openCardFromSelection}'));
  assert.ok(CHAT_SCREEN.includes('<ConversationCardModal'));
  assert.ok(CHAT_SCREEN.includes('messages={selectedMessagesForCard}'));
  assert.ok(CHAT_SCREEN.includes('characterName={String(character.name || \'\')}'));
  assert.ok(CHAT_SCREEN.includes('userName={String(userNameRef.current || \'\')}'));
});

test('生成面板：打开不自动请求，生成走解析+自修复，空壳不落库', () => {
  // 打开只准备素材，不触发请求
  assert.ok(!/useEffect\([\s\S]{0,400}generate\(\)/.test(MODAL), '挂载/打开时不得自动调用生成');
  assert.ok(MODAL.includes('onPress={generate}'), '生成由按钮触发');
  assert.ok(MODAL.includes('const generate = useCallback'));
  // 与制卡页一致的解析 + 截断自修复重试
  assert.ok(MODAL.includes('parseCardPatch(raw)'));
  assert.ok(MODAL.includes('buildJsonRepairPrompt(raw)'), '解析失败走一次自修复重试');
  // 保存前必须过 hasCardContent
  assert.ok(MODAL.includes('if (!hasCardContent(draft))'), '空卡不落库');
  assert.ok(MODAL.includes('await addCharacter(patch)'));
  assert.ok(MODAL.includes('ensureCharacterSession(created.id)'));
  // 保存路径与制卡页一致：先组系统提示词，再转角色补丁
  assert.ok(MODAL.includes('buildSystemPrompt({'));
  assert.ok(MODAL.includes('draftToCharacterPatch(draft, { composedPrompt })'));
});

test('面板：关闭/卸载时中止在途请求，避免结果写回已关闭的面板', () => {
  assert.ok(MODAL.includes('abortRef.current.abort()'));
  assert.ok(MODAL.includes('signal: controller.signal'));
});

test('制卡页与对话制卡共用同一份系统提示词与采样参数', () => {
  assert.ok(SHARED.includes('export const FORGE_SYSTEM'));
  assert.ok(SHARED.includes('export const FORGE_SAMPLING_OVERRIDES'));
  assert.ok(MODAL.includes('FORGE_SYSTEM') && MODAL.includes('FORGE_SAMPLING_OVERRIDES'));
  assert.ok(FORGE_SCREEN.includes('FORGE_SYSTEM') && FORGE_SCREEN.includes('FORGE_SAMPLING_OVERRIDES'));
  // 两处都必须是 import 来的，不能再各自 const 一份
  assert.ok(!/^const FORGE_SYSTEM\s*=/m.test(FORGE_SCREEN), '制卡页不得再本地定义 FORGE_SYSTEM');
  assert.ok(!/^const FORGE_SAMPLING_OVERRIDES\s*=/m.test(FORGE_SCREEN), '制卡页不得再本地定义采样参数');
  assert.ok(!/^const FORGE_SYSTEM\s*=/m.test(MODAL), '对话制卡不得本地定义 FORGE_SYSTEM');
});

test('对话制卡词条中英齐备', () => {
  const keys = [
    'chat.topBar.selection.forgeCard',
    'chat.topBar.a11y.forgeCard',
    'chat.cardFromChat.title',
    'chat.cardFromChat.selected',
    'chat.cardFromChat.dropped',
    'chat.cardFromChat.generate',
    'chat.cardFromChat.generating',
    'chat.cardFromChat.preview.title',
    'chat.cardFromChat.save',
    'chat.cardFromChat.edit',
    'chat.cardFromChat.regenerate',
    'chat.cardFromChat.saved.title',
    'chat.cardFromChat.saved.body',
    'chat.cardFromChat.error.parse',
    'chat.cardFromChat.error.saveFailed',
  ];
  keys.forEach(key => {
    assert.ok(ZH.includes(`'${key}'`), `zh-CN 缺 ${key}`);
    assert.ok(EN.includes(`'${key}'`), `en 缺 ${key}`);
  });
});
