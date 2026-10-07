// 记忆溯源 UI 接线结构守卫。项目无 React 渲染器，UI 层按既有约定用源码锚点
// 验证「组件/接线存在且约束成立」——重点是两条安全约束：
//   1) 任何改记忆的动作都必须是用户点出来的，打开面板只读；
//   2) 合并拿不到向量就放弃写入，绝不产生一条召不回的僵尸记忆。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

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
  // 打开时只读索引与冲突记录
  assert.ok(MODAL.includes('getVectorIndex(characterId)'));
  assert.ok(MODAL.includes('getMemoryConflicts(characterId)'));
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
  assert.ok(MODAL.includes('buildEvidenceChain({ memory, messages })'));
  assert.ok(MODAL.includes('chain.found === false'));
  assert.ok(MODAL.includes("t('memory.provenance.evidence.missing')"));
  assert.ok(MODAL.includes("t('memory.provenance.evidence.source')"), '标出哪条是记忆出处');
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
    'memory.provenance.evidence.delete',
    'memory.provenance.merge.noVector',
  ];
  keys.forEach(key => {
    assert.ok(ZH_MEMORY.includes(`'${key}'`), `zh-CN 缺 ${key}`);
    assert.ok(EN_MEMORY.includes(`'${key}'`), `en 缺 ${key}`);
  });
  assert.ok(ZH_CHAT.includes("'chat.menu.memoryProvenance'"), 'zh-CN 缺菜单词条');
  assert.ok(EN_CHAT.includes("'chat.menu.memoryProvenance'"), 'en 缺菜单词条');
});
