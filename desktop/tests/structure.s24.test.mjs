// 桌面外壳结构守卫（S24）：记忆页五个面板的页内逐项比对结论。
//
// 手机侧对应实现：
//   体检   memory/MemoryCheckupModal.js        → 桌面 MemoryCheckupPanel.jsx
//   孤儿   memory/useOrphanRecovery.js         → desktop OrphanRecoveryPanel.jsx
//   冲突   memory/MemoryProvenanceModal.js 的冲突段 → desktop MemoryConflictPanel.jsx
//   溯源   memory/MemoryProvenanceModal.js 的溯源段 → desktop MemoryProvenancePanel.jsx
//   搜索   SearchScreen.js（路由页）            → desktop GlobalSearchPanel.jsx
//
// 本轮查出的真实缺口（按严重度）：
//   1. **证据正文未脱敏**：座位视图直接渲染原始 message.text，把聊天页看不到的文字
//      在派生界面全文复现（隐私）。已抽共享叶子 evidenceText.js，两端同源。
//   2. 溯源不能删除单条记忆（手机可删：只动索引、不碰原始消息）。
//   3. 合并来源没逐条列出出处。
//   4. 无搜索结果时缺标题（只有说明，让人分不清「没搜到」与「还在搜」）。
//   5. 搜索结果的发言方用「默认助手」兜底，而手机用「角色已删除」明确提示。
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

const CHECKUP = read('src', 'memory', 'MemoryCheckupPanel.jsx');
const ORPHAN = read('src', 'memory', 'OrphanRecoveryPanel.jsx');
const CONFLICT = read('src', 'memory', 'MemoryConflictPanel.jsx');
const PROVENANCE = read('src', 'memory', 'MemoryProvenancePanel.jsx');
const SEARCH = read('src', 'memory', 'GlobalSearchPanel.jsx');

// ---------------------------------------------------------------------------
// 面板清单：手机面板 → 桌面等价物 → 控件级结论
// ---------------------------------------------------------------------------
const MEMORY_PANELS = Object.freeze([
  { id: 'checkup', mobile: 'MemoryCheckupModal', desktop: 'MemoryCheckupPanel', status: 'done' },
  { id: 'orphan', mobile: 'useOrphanRecovery', desktop: 'OrphanRecoveryPanel', status: 'done' },
  { id: 'conflict', mobile: 'ProvenanceModal(conflicts)', desktop: 'MemoryConflictPanel', status: 'done' },
  { id: 'provenance', mobile: 'ProvenanceModal(evidence)', desktop: 'MemoryProvenancePanel', status: 'ported' },
  { id: 'search', mobile: 'SearchScreen', desktop: 'GlobalSearchPanel', status: 'ported' },
]);

test('五个面板都有明确归属，且桌面实现真实存在', () => {
  const sources = { checkup: CHECKUP, orphan: ORPHAN, conflict: CONFLICT, provenance: PROVENANCE, search: SEARCH };
  for (const panel of MEMORY_PANELS) {
    const source = sources[panel.id];
    assert.ok(source && source.length > 300, `${panel.id} 桌面实现像是空壳`);
    assert.ok(/export default function/.test(source), `${panel.id} 没有导出组件`);
  }
});

test('体检面板：与手机用同一份判定（buildMemoryCheckup）且词条一致', () => {
  // 判定必须在共享层，桌面不得自己算「哪些会话缺摘要」。
  assert.ok(CHECKUP.includes('buildMemoryCheckup'), '未复用共享体检判定');
  assert.ok(CHECKUP.includes('singleChatSessionsOf'), '未复用共享单聊筛选');
  // 与手机同一批词条（本轮比对结果是完全一致）。
  const modal = readRoot('src', 'memory', 'MemoryCheckupModal.js');
  const mobileKeys = [...modal.matchAll(/t\('(memory\.checkup\.[a-zA-Z.]+)'\)/g)].map(m => m[1]);
  const desktopKeys = new Set([...CHECKUP.matchAll(/t\('(memory\.checkup\.[a-zA-Z.]+)'\)/g)].map(m => m[1]));
  assert.ok(mobileKeys.length >= 8, `手机体检词条解析异常：${mobileKeys.length}`);
  for (const key of mobileKeys) {
    assert.ok(desktopKeys.has(key), `体检面板缺词条 ${key}`);
  }
});

test('孤儿回收：复用共享恢复逻辑，并区分「扫描失败」与「没有孤儿」', () => {
  assert.ok(ORPHAN.includes('memory.recoverNotice'), '缺恢复提示');
  assert.ok(ORPHAN.includes('memory.recover.success.title'), '缺恢复成功');
  assert.ok(ORPHAN.includes('memory.recover.fail.title'), '缺恢复失败');
  // 扫描失败必须单独提示（不能渲染成「没有孤儿」）。
  assert.ok(ORPHAN.includes('memory.scan.fail.title'), '缺扫描失败提示');
});

test('证据正文必须与聊天页同源脱敏（隐私）——两端用同一个叶子函数', () => {
  const leaf = readRoot('src', 'memory', 'evidenceText.js');
  assert.ok(leaf.includes('export function maskEvidenceText'), '缺共享脱敏函数');
  assert.ok(leaf.includes("mode: 'display'") && leaf.includes('depth: 0'),
    '脱敏口径必须是 display / depth 0（与聊天页同源）');
  // 手机端改为从叶子引入（消除重复实现）。
  const modal = readRoot('src', 'memory', 'MemoryProvenanceModal.js');
  assert.ok(modal.includes("from './evidenceText.js'"), '手机端未改用共享脱敏');
  // 桌面：先脱敏再建链，并记录「正则读不出来」。
  assert.ok(PROVENANCE.includes('maskEvidenceText'), '桌面证据正文未脱敏');
  assert.ok(PROVENANCE.includes('placementOfRole'), '未按角色/用户分别应用正则');
  assert.ok(
    PROVENANCE.indexOf('maskEvidenceText(') < PROVENANCE.indexOf('buildEvidenceChain({ memory, messages: masked'),
    '必须先脱敏再建证据链（不能渲染时才想起来）'
  );
  assert.ok(PROVENANCE.includes('evidence.rawTextWarning'), '正则读不出来时未如实提示「正文是原文」');
});

test('溯源：可删除单条记忆（只动索引，不碰原始消息）', () => {
  assert.ok(PROVENANCE.includes('updateVectorIndex'), '缺索引更新（删除记忆的唯一正确入口）');
  assert.ok(PROVENANCE.includes('removeMemoryConflictsForMemories'), '删除后未清理引用它的冲突记录');
  assert.ok(PROVENANCE.includes('memory.provenance.evidence.delete'), '缺删除入口');
  assert.ok(PROVENANCE.includes('memory.provenance.evidence.deleteConfirm.body'), '缺删除确认');
  // 语义纪律：删的是「被记住」这件事，原始消息留在会话里 —— 不得调删会话的 API。
  assert.ok(!/deleteSession|deleteSessions/.test(PROVENANCE), '删除记忆不应删会话');
});

test('溯源：合并来源逐条列出出处', () => {
  assert.ok(PROVENANCE.includes('memory.provenance.evidence.mergedFrom'), '缺合并来源标题');
  assert.ok(/sources\.map\(/.test(PROVENANCE), '合并来源未逐条渲染');
});

test('全库搜索：无结果给标题 + 说明；发言方兜底用「角色已删除」', () => {
  assert.ok(SEARCH.includes('search.empty.notFound.title'), '缺无结果标题');
  assert.ok(SEARCH.includes('search.empty.notFound.description'), '缺无结果说明');
  // 角色名按 characterId 查（搜索结果本身不带名字）。
  assert.ok(SEARCH.includes('characterMap'), '缺角色名映射');
  assert.ok(SEARCH.includes('search.result.missingCharacter'), '缺「角色已删除」兜底');
  // 不得再用「默认助手」当单聊发言方兜底（语义错位）。
  assert.ok(!/chat\.displayName\.defaultAssistant/.test(SEARCH), '不应把默认助手名当兜底');
});

test('冲突面板：三种处置都在（保留 A / 保留 B / 忽略）', () => {
  for (const key of ['keepA', 'keepB', 'ignore', 'merge']) {
    assert.ok(CONFLICT.includes(`memory.provenance.conflicts.${key}`), `冲突面板缺 ${key}`);
  }
  // 读损坏时如实提示，不显示「没有冲突」。
  assert.ok(CONFLICT.includes('memory.provenance.conflicts.corrupt'), '缺冲突读损坏提示');
});