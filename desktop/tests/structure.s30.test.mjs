// 桌面外壳结构守卫（S30）：数据生命周期写路径的反向审计。
//
// 前三轮的缺口都是「页面里少个控件」。这一轮反过来问：**哪些删除路径会留下孤儿数据？**
// 逐条核对三类引用，结论如下——
//
//   1. 群成员被删 → 群聊 members / memberProfiles 里残留 id。
//      **不构成功能差距**：桌面解析群成员时跳过已删角色（groupCharactersRef 只含现存
//      角色），调度器因此不会向幽灵成员发言；界面另有 missingIds 显式提示「群聊少了人」。
//      手机端同样不清理这两个字段。残留只是数据层面的不整洁，不影响运行与可观测性。
//
//   2. 会话被删 → 向量记忆与动态引用。
//      **已覆盖**：deleteSession / deleteSessions 内部调
//      removeVectorIndexForSession(s)（带 pruneSources）；记忆页删除另在上层先删
//      关联动态（deleteMomentsBySessionIds），且有「动态先删、会话后删」的顺序纪律。
//
//   3. 日记条目引用已删会话（sourceSessionIds）。
//      **两端共同的缺口，不属于「桌面落后手机」**：手机 DiaryPanel 的 diarySource 同样
//      在会话不存在时降级为「该对话已删除」且不可点，桌面照抄了同一降级。所以它不是
//      需要补的移植差距；本守卫把它钉成「优雅降级」的契约，防止将来有人改成抛错。
//
// 另外钉住一条：角色删除的编排必须继续覆盖三类关联数据（见 s29），这是本轮之前补的，
// 不能回退成只删角色表那一行。
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

const GROUP_MODEL = read('src', 'group', 'groupModel.js');
const DESKTOP_CHAT = read('src', 'provider', 'useDesktopChat.js');
const GROUP_SETTINGS = read('src', 'group', 'GroupSettingsPanel.jsx');
const MEMORY = read('src', 'memory', 'MemoryListScreen.jsx');
const DIARY = read('src', 'extension', 'screens', 'DiaryScreen.jsx');

test('群成员被删：调度器不会向幽灵成员发言（解析时跳过已删角色）', () => {
  // groupCharactersRef 只含现存角色：这是「残留 id 无害」的前提，必须钉住。
  assert.ok(/跳过已被删除的成员/.test(DESKTOP_CHAT) || /missing/i.test(DESKTOP_CHAT),
    '群成员解析应过滤已删角色');
  assert.ok(DESKTOP_CHAT.includes('groupCharactersRef'), '缺群成员 ref');
  // 缺失成员要能让用户看见（群聊少了一个人不是静默的）。
  assert.ok(GROUP_MODEL.includes('missingIds'), '缺缺失成员统计');
  assert.ok(GROUP_SETTINGS.includes('group.members.missing'), '缺缺失成员提示');
  // 共享层仍按 members 派发，但拿到的已是过滤后的列表（selectSpeakers 只从这些里选）。
  const send = readRoot('src', 'chat', 'useChatSend.js');
  assert.ok(/selectSpeakers\(\{\s*characters: members/.test(send), '选人应只从现存成员里选');
});

test('会话被删：向量记忆在存储层就清理（不依赖界面记得调）', () => {
  const mutations = readRoot('src', 'storage', 'sessionList', 'mutations.js');
  assert.ok(mutations.includes('removeVectorIndexForSession'), '删单会话应清向量');
  assert.ok(mutations.includes('removeVectorIndexForSessions'), '批量删应清向量');
  // pruneSources：连「引用了这些消息」的合并来源也一并修剪，避免悬空引用。
  assert.ok(/pruneSources: true/.test(mutations), '清理向量时应修剪来源引用');
});

test('会话被删：关联动态有「先删动态、后删会话」的顺序纪律', () => {
  assert.ok(MEMORY.includes('deleteMomentsBySessionIds'), '记忆页删除应清关联动态');
  // 动态读不出来必须中止（宁可不删，也不在不知道关联量时动手）。
  assert.ok(MEMORY.includes('moments.readFail') || MEMORY.includes('memory.moments.readFail'),
    '动态读取失败应中止删除');
  // 顺序：删除动态的调用要出现在 deleteSession 之前。
  const deleteMomentAt = MEMORY.indexOf('await deleteMomentsBySessionIds');
  const deleteSessionAt = MEMORY.indexOf('await deleteSession(session.id)');
  assert.ok(deleteMomentAt > 0 && deleteSessionAt > 0, '两处调用都应存在');
  assert.ok(deleteMomentAt < deleteSessionAt, '必须先删动态再删会话');
});

test('日记引用已删会话：优雅降级为「该对话已删除」，不得抛错', () => {
  // 这是两端共同的缺口（手机也不清理 sourceSessionIds），所以判据是「降级」而不是「清理」。
  const shared = readRoot('src', 'diary', 'diary.js');
  assert.ok(shared.includes('sourceSessionIds'), '日记应记录来源会话');
  assert.ok(DIARY.includes('diary.source.deleted'), '会话不存在时应显示「该对话已删除」');
  assert.ok(/openable:\s*false/.test(DIARY), '不可打开时要标 openable=false');
  // 点击不可打开的来源不应抛错/跳转（直接 return）。
  assert.ok(/if \(!diarySource \|\| !diarySource\.openable\) return;/.test(DIARY),
    '不可打开时 early return');
  // 跳转失败要有回滚与提示（与本轮之前补的来源跳转同一纪律）。
  assert.ok(/diary\.source\.jumpFailed/.test(DIARY), '缺跳转失败提示');
  assert.ok(/previousSessionId/.test(DIARY), '缺失败回滚');
});

test('角色删除编排不回退（仍覆盖 角色 + 动态 + 会话 三步）', () => {
  const hook = read('src', 'character', 'useDesktopCharacterDelete.js');
  for (const marker of ['runCharacterDelete', 'removeMomentsStep', 'deleteSessionsStep', 'deleteCharactersStep']) {
    assert.ok(hook.includes(marker), `删除编排缺 ${marker}`);
  }
});