// 记忆溯源 UI 接线结构守卫。项目无 React 渲染器，UI 层按既有约定用源码锚点
// 验证「组件/接线存在且约束成立」——重点是三条安全约束：
//   1) 任何改记忆的动作都必须是用户点出来的，打开面板只读；
//   2) 合并拿不到向量就放弃写入，绝不产生一条召不回的僵尸记忆；
//   3) 面板展示的对话正文必须过显示层正则（与聊天页同口径），不得复现被隐藏的原文。
// 第 3 条不能只靠源码锚点（「接线存在」不等于「文字真的被过滤了」），所以本文件额外
// 用桩把面板模块加载进来，直接调它导出的 maskEvidenceText 跑真结果（见文件末尾）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Module, { createRequire } from 'node:module';
import path from 'node:path';

import { REGEX_PLACEMENT } from '../src/prompt/regexEngine.js';

const require = createRequire(import.meta.url);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = rel => readFileSync(path.join(HERE, '..', rel), 'utf8');

const CHAT_SCREEN = read('src/ChatScreen.js');
const MODAL = read('src/memory/MemoryProvenanceModal.js');
const ZH_MEMORY = read('src/i18n/locales/zh-CN/memory.js');
const EN_MEMORY = read('src/i18n/locales/en/memory.js');
const ZH_CHAT = read('src/i18n/locales/zh-CN/chat.js');
const EN_CHAT = read('src/i18n/locales/en/chat.js');

test('ChatScreen：⋯ 菜单「其他」区挂记忆溯源入口并渲染面板', () => {
  assert.ok(CHAT_SCREEN.includes("import MemoryProvenanceModal from './memory/MemoryProvenanceModal.js';"));
  assert.ok(CHAT_SCREEN.includes("key: 'memory-provenance'"));
  assert.ok(CHAT_SCREEN.includes("label: t('chat.menu.memoryProvenance')"));
  assert.ok(CHAT_SCREEN.includes("section: t('chat.menu.section.other')"));
  assert.ok(CHAT_SCREEN.includes('onPress: () => setMemoryProvenanceOpen(true)'));
  assert.ok(CHAT_SCREEN.includes('<MemoryProvenanceModal'));
  assert.ok(CHAT_SCREEN.includes('characterId={characterId}'));
  assert.ok(CHAT_SCREEN.includes('characterName={String(character.name || \'\')}'));
  assert.ok(CHAT_SCREEN.includes('sessions={sessions}'));
});

test('面板：打开只读，改记忆的动作全部由用户触发', () => {
  // 打开时只读索引与冲突记录——且走三态版本（*Status），读失败不能压成空数组
  assert.ok(MODAL.includes('getVectorIndexStatus(characterId)'));
  assert.ok(MODAL.includes('getMemoryConflictsStatus(characterId)'));
  // 所有写操作都出现在 useCallback 动作里，且由按钮 onPress 触发
  assert.ok(MODAL.includes('const onKeep = useCallback'));
  assert.ok(MODAL.includes('const onMerge = useCallback'));
  assert.ok(MODAL.includes('const onIgnore = useCallback'));
  assert.ok(MODAL.includes('const onDeleteMemory = useCallback'));
  assert.ok(MODAL.includes('onPress={() => onKeep(record, \'a\')}'));
  assert.ok(MODAL.includes('onPress={() => onMerge(record)}'));
  assert.ok(MODAL.includes('onPress={() => onIgnore(record)}'));
  // 删除记忆要二次确认
  assert.ok(MODAL.includes('Alert.alert('), '删除走确认弹窗');
  assert.ok(MODAL.includes("t('memory.provenance.evidence.deleteConfirm.title')"));
  // 检测冲突也是显式按钮，不在打开时自动跑（要花模型调用）
  assert.ok(MODAL.includes('onPress={onScan}'));
  assert.ok(MODAL.includes('const onScan = useCallback'));
});

test('面板：合并先取向量，取不到就放弃写入', () => {
  assert.ok(MODAL.includes('await embedTexts({ config, texts: [mergedText] })'));
  assert.ok(MODAL.includes('vectorSignature(config)'), '合并记忆要带当前向量指纹，否则召回时被指纹过滤掉');
  assert.ok(
    MODAL.indexOf('merge.noVector') > MODAL.indexOf('await embedTexts('),
    '向量为空时必须抛错中止，而不是写一条没有向量的记忆'
  );
  assert.ok(MODAL.includes("origin: 'merged'"), '合并记忆标记来源类型');
  assert.ok(MODAL.includes('mergedFrom: [left, right].map('), '保留合并前快照，证据链不断');
  assert.ok(MODAL.includes('const targets = new Set([record.aKey, record.bKey]);'), '合并后移除两条原文');
});

test('面板：证据链对「源消息已不在」如实降级，不伪造', () => {
  // 证据链只从三态读到的消息体构建（corrupt 时 messages 为空，buildEvidenceChain 自己
  // 返回 found:false），绝不凭空造一条凑数的上下文。
  assert.ok(MODAL.includes('buildEvidenceChain({ memory, messages:'));
  assert.ok(MODAL.includes('(state ? state.messages : [])'));
  assert.ok(MODAL.includes('chain.found === false'));
  assert.ok(MODAL.includes("t('memory.provenance.evidence.missing')"));
  assert.ok(MODAL.includes("t('memory.provenance.evidence.source')"), '标出哪条是记忆出处');
});

// P0-1 / P0-3：读失败（corrupt）曾经与「确实没有」「消息已删除」完全同形——
// getVectorIndex / getMemoryConflicts / getMessagesBySession 都把读失败压成 []，
// 面板于是显示「还没有向量记忆」和「原始消息已经不在了（消息被删除或重新生成过）」，
// 用户会把「读不出来」当成自己删过东西。这条守卫钉住三态渲染。
test('面板：读失败与「没有记忆」「消息已删除」分开渲染，不归错因', () => {
  // 索引损坏 → 独立空态，不落到「还没有向量记忆」
  assert.ok(MODAL.includes("if (indexStatus === 'corrupt')"));
  assert.ok(MODAL.includes("t('memory.provenance.corrupt.title')"));
  assert.ok(MODAL.includes("t('memory.provenance.corrupt.backup')"), '损坏时说明备份已留');
  // 冲突记录读失败 → 明确说「列出的冲突可能不完整」
  assert.ok(MODAL.includes("conflictsStatus === 'corrupt'"));
  assert.ok(MODAL.includes("t('memory.provenance.conflicts.corrupt')"));
  // 证据链走三态读消息体，corrupt 用独立文案
  assert.ok(MODAL.includes('getMessagesBySessionStatus('));
  assert.ok(MODAL.includes("state.status === 'corrupt'"));
  assert.ok(MODAL.includes("t('memory.provenance.evidence.readFail')"));
  // corrupt 分支绝不能复用 evidence.missing（那是在说「消息被删了」）
  const corruptBranch = MODAL.slice(
    MODAL.indexOf('getMessagesBySessionStatus('),
    MODAL.indexOf('const onDeleteMemory')
  );
  assert.ok(!corruptBranch.includes('evidence.missing'), '读失败不得复用「消息已不在」文案');
  assert.ok(corruptBranch.includes('evidence.readFail'), '读失败有自己的文案');
});

test('记忆溯源词条中英齐备', () => {
  const keys = [
    'memory.provenance.title',
    'memory.provenance.scan',
    'memory.provenance.scan.done',
    'memory.provenance.scan.none',
    'memory.provenance.empty.title',
    'memory.provenance.bySession',
    'memory.provenance.badge.merged',
    'memory.provenance.badge.conflict',
    'memory.provenance.conflicts.title',
    'memory.provenance.conflicts.keepA',
    'memory.provenance.conflicts.keepB',
    'memory.provenance.conflicts.merge',
    'memory.provenance.conflicts.ignore',
    'memory.provenance.evidence.title',
    'memory.provenance.evidence.source',
    'memory.provenance.evidence.missing',
    'memory.provenance.evidence.readFail',
    'memory.provenance.evidence.readFailBackup',
    'memory.provenance.evidence.rawTextWarning',
    'memory.provenance.corrupt.title',
    'memory.provenance.corrupt.body',
    'memory.provenance.corrupt.backup',
    'memory.provenance.conflicts.corrupt',
    'memory.provenance.evidence.delete',
    'memory.provenance.merge.noVector',
    'memory.checkup.sessions.partial',
    'memory.checkup.issue.boundary',
    'memory.checkup.issue.unknown',
    'memory.checkup.clean.skippedUnknown',
  ];
  keys.forEach(key => {
    assert.ok(ZH_MEMORY.includes(`'${key}'`), `zh-CN 缺 ${key}`);
    assert.ok(EN_MEMORY.includes(`'${key}'`), `en 缺 ${key}`);
  });
  assert.ok(ZH_CHAT.includes("'chat.menu.memoryProvenance'"), 'zh-CN 缺菜单词条');
  assert.ok(EN_CHAT.includes("'chat.menu.memoryProvenance'"), 'en 缺菜单词条');
});

// ---------------------------------------------------------------------------
// P1-6a：证据链正文必须与聊天页同源脱敏（display 模式正则）
// ---------------------------------------------------------------------------
// 缺陷：面板直接渲染 getMessagesBySessionStatus 读到的**原始** message.text，而聊天页走
// applyRegexScripts(..., { mode: 'display' })（ChatScreen.js:588-615）。角色卡正则最常见的
// 用途就是隐藏内容 ⇒ 同一个会话里「聊天页看不到的文字」在溯源面板里全文可见。
//
// 这里用桩把面板模块真正加载进来（babel 转 JSX + Module._load 替掉 RN/存储依赖，做法与
// tests/vectorMemory.test.mjs 加载 storage/vector.js 相同），直接跑它的脱敏函数——
// 只断言「源码里出现了某个调用」证明不了文字真的被过滤掉了。
const MODAL_PATH = path.resolve('src/memory/MemoryProvenanceModal.js');
const MODAL_CODE = require('@babel/core').transformSync(read('src/memory/MemoryProvenanceModal.js'), {
  babelrc: false,
  configFile: false,
  filename: MODAL_PATH,
  presets: [
    [require.resolve('@babel/preset-env'), { targets: { node: 'current' }, modules: 'commonjs' }],
    [require.resolve('@babel/preset-react'), { runtime: 'classic' }],
  ],
}).code;

const noop = () => {};
const MODAL_STUBS = [
  ['react', {
    __esModule: true,
    default: { createElement: () => null, Fragment: 'Fragment' },
    useCallback: fn => fn,
    useEffect: noop,
    useMemo: fn => fn(),
    useRef: value => ({ current: value }),
    useState: value => [value, noop],
  }],
  ['react-native', {
    ActivityIndicator: 'ActivityIndicator',
    Alert: { alert: noop },
    Modal: 'Modal',
    ScrollView: 'ScrollView',
    StyleSheet: { create: styles => styles },
    Text: 'Text',
    TouchableOpacity: 'TouchableOpacity',
    View: 'View',
  }],
  ['@expo/vector-icons/Ionicons', { __esModule: true, default: 'Ionicons' }],
  ['/api.js', { sendChatMessage: async () => '' }],
  ['/storage/sessions.js', { getMessagesBySessionStatus: async () => ({ status: 'missing', messages: [] }) }],
  ['/storage/characters.js', { getCharacterLibrary: async () => [] }],
  ['/storage/vector.js', {
    getVectorIndexStatus: async () => ({ status: 'missing', index: [] }),
    getVectorMemoryConfig: async () => ({}),
    updateVectorIndex: async () => [],
  }],
  ['/storage/memoryConflicts.js', {
    getMemoryConflictsStatus: async () => ({ status: 'missing', records: [] }),
    removeMemoryConflictsForMemories: noop,
    resolveMemoryConflict: noop,
    upsertMemoryConflicts: noop,
  }],
  ['/vectorMemory/index.js', { embedTexts: async () => [], vectorSignature: () => '' }],
  ['/ui/index.js', { Card: 'Card', EmptyState: 'EmptyState', GhostButton: 'GhostButton', PrimaryButton: 'PrimaryButton' }],
  ['/theme/ThemeContext.js', { useTheme: () => ({ theme: { colors: {} }, fonts: { scaled: n => n }, tokens: {} }) }],
  ['/i18n/I18nContext.js', { useTranslation: () => ({ t: key => key }) }],
];

const modalRuntime = new Module(MODAL_PATH);
modalRuntime.filename = MODAL_PATH;
modalRuntime.paths = Module._nodeModulePaths(path.dirname(MODAL_PATH));
const originalLoad = Module._load;
Module._load = function patchedModalLoad(request, parent, isMain) {
  const stub = MODAL_STUBS.find(([suffix]) => request === suffix || request.endsWith(suffix));
  if (stub) return stub[1];
  return originalLoad.call(this, request, parent, isMain);
};
try {
  modalRuntime._compile(MODAL_CODE, MODAL_PATH);
} finally {
  Module._load = originalLoad;
}
const { maskEvidenceText } = modalRuntime.exports;

// 一条「隐藏某段文字」的角色卡正则：把口令整段换成占位符（用户能看见的只有占位符）。
const HIDE_SECRET = [{
  id: 'hide-secret',
  name: '隐藏口令',
  enabled: true,
  placement: [REGEX_PLACEMENT.USER_INPUT, REGEX_PLACEMENT.AI_OUTPUT],
  findRegex: '/绝密口令\\s*\\S+/g',
  replaceString: '[已隐藏]',
  flags: 'g',
}];

test('P1-6a：证据链正文过 display 正则，被隐藏的文字不出现在面板文本里', () => {
  const message = { id: 'm1', role: 'assistant', text: '开场 绝密口令 hunter2 收尾' };
  const shown = maskEvidenceText(message, HIDE_SECRET, REGEX_PLACEMENT.AI_OUTPUT);
  assert.ok(!shown.includes('hunter2'), `面板正文不得出现被正则隐藏的文字，实际：${shown}`);
  assert.ok(shown.includes('[已隐藏]'), `应显示替换后的文本，实际：${shown}`);
  assert.ok(shown.includes('开场') && shown.includes('收尾'), '未被正则命中的部分原样保留');
});

test('P1-6a：placement 与聊天页同一判定（用户输入的正则不改角色输出）', () => {
  const userOnly = [{
    id: 'user-only',
    name: '仅用户输入',
    enabled: true,
    placement: [REGEX_PLACEMENT.USER_INPUT],
    findRegex: '/秘密/g',
    replaceString: '',
    flags: 'g',
  }];
  assert.equal(maskEvidenceText({ text: '秘密' }, userOnly, REGEX_PLACEMENT.USER_INPUT), '');
  assert.equal(
    maskEvidenceText({ text: '秘密' }, userOnly, REGEX_PLACEMENT.AI_OUTPUT),
    '秘密',
    'placement 不匹配的正则不得误伤角色输出'
  );
});

test('P1-6a：没有脚本 / 文本为空时原样返回，不抛错', () => {
  assert.equal(maskEvidenceText({ text: '原文' }, [], REGEX_PLACEMENT.AI_OUTPUT), '原文');
  assert.equal(maskEvidenceText({ text: '原文' }, null, REGEX_PLACEMENT.AI_OUTPUT), '原文');
  assert.equal(maskEvidenceText(null, HIDE_SECRET, REGEX_PLACEMENT.AI_OUTPUT), '');
});

test('P1-6a：面板把证据链与合并来源的正文都接到脱敏函数上', () => {
  assert.ok(MODAL.includes("import { applyRegexScripts, REGEX_PLACEMENT } from '../prompt/regexEngine.js';"));
  assert.ok(MODAL.includes("import { getCachedDisplayText } from './displayTextCache.js';"));
  assert.ok(MODAL.includes('const placementOfRole = role =>'), '角色→placement 判定与聊天页同源');
  assert.ok(
    MODAL.includes('maskEvidenceText(item, scripts.list, placementOfRole(item.role))'),
    '证据链正文（源消息 + 前后文）必须逐条过脱敏'
  );
  assert.ok(MODAL.includes('maskSource(source)'), '合并来源快照同样要脱敏');
  assert.ok(
    MODAL.indexOf('const maskMessage') < MODAL.indexOf('buildEvidenceChain({ memory, messages:'),
    '必须先脱敏再建证据链，而不是渲染时才想起来'
  );
  // 脱敏依据（角色卡正则）读不出来时不能静默显示原文
  assert.ok(MODAL.includes('const resolveScripts = useCallback'));
  assert.ok(MODAL.includes("t('memory.provenance.evidence.rawTextWarning')"));
});
