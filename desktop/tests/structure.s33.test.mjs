// 桌面外壳结构守卫（S33）：交互时序（竞态）审计。
//
// 本轮核对了四类时序行为，结论：
//
//   1. 连点发送 → **已防护**。桌面 submit 有一道 isSending 守卫，但那是 state；
//      真正的同步闸在共享 useChatSend（performSendMessage 开头检查 sendLockRef.current，
//      非空即拒绝）。桌面已把 sendLockRef 传进去，所以同帧连点只会进一次。
//
//   2. 切会话时在途回复 → **已防护**。回复返回后若 isCurrentSession() 为 false，
//      走 persistBackgroundReply 写回**它自己的会话**（ownerCharacterId 从
//      sessionsRef 按 sendSessionId 查），而不是丢进当前界面。sessionsRef 每渲染
//      同步更新，桌面接线正确。
//
//   3. 快速切换模型 → **已防护**。共享层用 expectedConfigId + fingerprint 做乐观并发：
//      返回时配置已变则抛 configChangedError；上层把 sourceChangedRef 置真，并在
//      下一次发送前提示「配置已变更，草稿已保留」。桌面只需传入该 ref（已做）。
//
//   4. 快速勾选群成员 → **查出真缺口并修复**。GroupSettingsPanel 原先用 `saving`
//      state 做守卫，而同帧连点两次都会读到 false；第二次会用**渲染时的 selectedIds
//      快照**重算 next，把第一次的增删覆盖掉（丢用户操作）。已改为 savingRef 同步守卫。
//      注：共享 setGroupMembers 内部会重读 sessions，所以落库不会基于旧数据——
//      丢的是界面算出来的 next，不是存储层。
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

const PANE = read('src', 'provider', 'ChatPane.jsx');
const DESKTOP_CHAT = read('src', 'provider', 'useDesktopChat.js');
const GROUP_SETTINGS = read('src', 'group', 'GroupSettingsPanel.jsx');
const SEND = readRoot('src', 'chat', 'useChatSend.js');

test('连点发送：共享层有同步闸（sendLockRef），桌面已接线', () => {
  // 同步闸：performSendMessage 开头，ref 非空即拒绝（state 会晚一帧）。
  assert.ok(/if \(isSending \|\| isSwitching \|\| sessionTransitionPending \|\| !ready \|\| sendLockRef\.current\) return;/.test(SEND),
    '共享层应有含 sendLockRef 的同步前置守卫');
  assert.ok(DESKTOP_CHAT.includes('sendLockRef'), '桌面应传入 sendLockRef');
  // 桌面自己那道 isSending 守卫保留（早退，省一次无谓调用）。
  assert.ok(/isSending \|\| !ready\) return;/.test(PANE), '桌面应保留 isSending 早退');
});

test('切会话：在途回复写回它自己的会话，不丢也不串', () => {
  assert.ok(SEND.includes('persistBackgroundReply'), '共享层应有后台落库');
  // owner 必须按 sendSessionId 查（不是当前会话）。
  assert.ok(/sessionId: sendSessionId/.test(SEND), '后台落库应指向发起时的会话');
  assert.ok(/find\(item => item\.id === sendSessionId\)/.test(SEND),
    'ownerCharacterId 应按发起会话查，而不是当前角色');
  // 桌面 sessionsRef 每渲染同步（否则查不到刚切的会话）。
  assert.ok(/sessionsRef\.current = sessions/.test(DESKTOP_CHAT), 'sessionsRef 应每次渲染同步');
});

test('切模型/配置：乐观并发守卫 + 变更提示都由共享层承担', () => {
  assert.ok(SEND.includes('isConfigChangedError'), '共享层应识别配置变更错误');
  assert.ok(/sourceChangedRef\.current = true/.test(SEND), '配置变更应置标记');
  assert.ok(SEND.includes('chat.send.sourceChanged.draftKeptBody'),
    '应提示「草稿已保留」而不是静默丢稿');
  // 桌面只需传入 ref（接线正确即可，逻辑不重复实现）。
  assert.ok(DESKTOP_CHAT.includes('sourceChangedRef'), '桌面应传入 sourceChangedRef');
});

test('快速勾选群成员：用同步 ref 守卫，不用 state', () => {
  assert.ok(GROUP_SETTINGS.includes('savingRef'), '群设置应有同步守卫 ref');
  // 三个写入路径（改模式 / 增删成员 / 改群名）都必须过 ref。
  const refGuards = (GROUP_SETTINGS.match(/savingRef\.current/g) || []).length;
  assert.ok(refGuards >= 6, `savingRef 使用点太少（${refGuards}），可能漏了某条写入路径`);
  // 不得再用 state 做唯一守卫。
  assert.ok(!/if \(saving \|\| !session\) return;/.test(GROUP_SETTINGS), '不应只用 state 守卫');
  // 落库仍走共享层（它内部会重读 sessions，不基于旧快照）。
  assert.ok(GROUP_SETTINGS.includes('setGroupMembers'), '应走共享写入');
  const mutations = readRoot('src', 'storage', 'sessionList', 'mutations.js');
  assert.ok(/async function setGroupMembersInternal[\s\S]{0,160}await requireSessions\(\)/.test(mutations),
    '共享层应重读会话（不基于调用方快照）');
});

test('其余一次性动作（导入/生图/制卡）的 busy state 守卫可接受', () => {
  // 这些动作不基于「当前列表算新列表」，连点最坏是两次独立请求（共享队列会串行），
  // 不会丢用户操作。本断言只是记录这个判断，防止将来被误当成同类 bug。
  for (const file of [
    ['src', 'extension', 'screens', 'ImageGenScreen.jsx'],
    ['src', 'extension', 'screens', 'CardForgeScreen.jsx'],
    ['src', 'extension', 'screens', 'MusicScreen.jsx'],
    ['src', 'extension', 'screens', 'BooksScreen.jsx'],
  ]) {
    const source = read(...file);
    assert.ok(/if \(busy\) return;/.test(source), `${file.join('/')} 应有 busy 早退`);
  }
});