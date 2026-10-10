// L 系「Agent 运行时与 UI 分离」的源码接线断言（RN 运行时进不去，Node 只做静态检查）。
// 关键回归钉：
// - 发送准入按**会话**判定（别的会话后台跑不影响本会话发送）；
// - 切会话**不再中止**正在跑的运行（invalidate 改为 detach），运行跑完落回自己的会话；
// - 聊天页卸载不再中断生成（L0c）；
// - 后台完成（用户已离开）时把结果写回它自己的会话（useChatSend 后台落库分支）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = rel => fs.readFileSync(path.resolve(rel), 'utf8');

const GUARD = read('src/chat/useSessionGuard.js');
const MESSAGES = read('src/chat/useSessionMessages.js');
const SEND = read('src/chat/useChatSend.js');
const CHAT = read('src/ChatScreen.js');
const RUNS = read('src/agent/runtime/sessionRuns.js');

test('useSessionGuard：准入按会话判定，登记/注销走 sessionRuns', () => {
  assert.ok(GUARD.includes("import { sessionRuns } from '../agent/runtime/sessionRuns.js';"), '导入登记表');
  assert.ok(GUARD.includes('if (sessionRuns.has(sessionId)) return null;'), '同一会话不重复准入');
  assert.ok(GUARD.includes('sessionRuns.start(sessionId,'), '登记运行（带 token）');
  assert.ok(GUARD.includes('sessionRuns.finish(token.sessionId);'), '按会话注销');
  assert.ok(GUARD.includes('syncActiveRun();'), '结束后重算活动会话的界面锁');
});

test('useSessionGuard：invalidate 只 detach，不中止后台运行', () => {
  // L 系核心语义：切会话不再 abortRef.abort()，运行继续跑完。
  assert.equal(GUARD.includes('abortRef.current.abort();'), false, '不得存在对 abortRef 的直接中止');
  assert.ok(GUARD.includes('sendLockRef.current = null;'), 'detach：摘掉界面锁');
  assert.ok(GUARD.includes('sessionVersionRef.current += 1;'), 'detach：推进版本号让飞行回复的界面写入失效');
});

test('useSessionGuard：syncActiveRun 按活动会话恢复锁/控制器/isSending', () => {
  assert.ok(GUARD.includes("const run = sessionRuns.get(String(activeSessionIdRef.current || ''));"));
  assert.ok(GUARD.includes('sendLockRef.current = run ? run.token : null;'));
  assert.ok(GUARD.includes('abortRef.current = run ? run.controller : null;'));
  assert.ok(GUARD.includes('setIsSending(Boolean(run));'));
});

test('useSessionMessages：切会话对齐界面锁，不中止运行', () => {
  assert.ok(MESSAGES.includes('syncActiveRun,'), '接收 syncActiveRun');
  assert.ok(MESSAGES.includes('syncActiveRun();'), '会话切换时调用');
  assert.equal(MESSAGES.includes('abortRef.current.abort()'), false, '不再中止后台运行');
  // 主动消息 tick 刷新在「活动会话在跑」时仍要跳过，避免覆盖未落盘的回复。
  assert.ok(MESSAGES.includes('if (sendLockRef.current || abortRef.current) return undefined;'));
});

test('ChatScreen（L0c）：卸载不再中断生成；仅用户停止才 abort', () => {
  const aborts = CHAT.match(/abortRef\.current\.abort\(\)/g) || [];
  assert.equal(aborts.length, 1, '全页只剩 onStop 一处 abort');
  assert.ok(CHAT.includes('const onStop = useCallback(() => {'));
  assert.equal(CHAT.includes('// 卸载时中断进行中的发送'), false, '旧卸载中止 effect 已移除');
});

test('useChatSend：后台完成时把回复写回它自己的会话', () => {
  assert.ok(SEND.includes('saveMessagesBySession,'), '从存储门面导入整体覆盖写盘');
  assert.ok(SEND.includes('async function persistBackgroundReply({'), '后台落库辅助函数');
  // 成功分支：当前会话走界面写入，否则走后台落库。
  assert.ok(/if \(isCurrentSession\(\)\) \{\s*\n\s*setMessages\(current => replacePendingWithReply/.test(SEND), '当前会话写界面');
  assert.ok(SEND.includes('await persistBackgroundReply({'), '非当前会话写回自己的会话');
});

test('sessionRuns：登记表记录发送令牌，供切回时恢复界面锁', () => {
  assert.ok(RUNS.includes('token: source.token || null,'), 'run 上保存 token');
});
