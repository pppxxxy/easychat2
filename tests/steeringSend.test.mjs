// I1 聊天页接线：运行中发送的判定（纯函数）。
//
// 这条判定决定「用户打的字会不会丢」，所以按仓库纪律用行为测试钉住每一种组合，
// 而不是靠 UI 里的 if 兜。工作区宿主（ChatPanel）走同一套语义。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { resolveSteeringSend, STEERING_SEND_ACTIONS } from '../src/chat/steeringSend.js';

test('没有在跑的请求 → 正常发送（steering 不介入）', () => {
  assert.deepEqual(resolveSteeringSend({}), { action: STEERING_SEND_ACTIONS.SEND });
  assert.deepEqual(
    resolveSteeringSend({ inFlight: false, text: '你好', hasAttachments: true }),
    { action: STEERING_SEND_ACTIONS.SEND },
    '不在跑时附件照旧走正常发送'
  );
});

test('在跑 + 有文字 + 本轮是工具循环 → 入队（trim 后入队）', () => {
  assert.deepEqual(
    resolveSteeringSend({ inFlight: true, text: '  先别改 UI  ', steeringAvailable: true }),
    { action: STEERING_SEND_ACTIONS.QUEUED, text: '先别改 UI' }
  );
});

test('在跑 + 空文字 → blocked(empty)：什么都不做，也不提示', () => {
  assert.deepEqual(
    resolveSteeringSend({ inFlight: true, text: '   ', steeringAvailable: true }),
    { action: STEERING_SEND_ACTIONS.BLOCKED, reason: 'empty' }
  );
});

test('在跑 + 带附件 → blocked(attachments)：补充指令是纯文本语义', () => {
  assert.deepEqual(
    resolveSteeringSend({ inFlight: true, text: '看看这个', hasAttachments: true, steeringAvailable: true }),
    { action: STEERING_SEND_ACTIONS.BLOCKED, reason: 'attachments' }
  );
});

test('在跑但不是工具循环 → blocked(noLoop)：收了也没地方注入，等于吞掉用户的字', () => {
  assert.deepEqual(
    resolveSteeringSend({ inFlight: true, text: '换个方向', steeringAvailable: false }),
    { action: STEERING_SEND_ACTIONS.BLOCKED, reason: 'noLoop' }
  );
});

test('判定优先级：空文字 > 附件 > 非循环（先给出最贴近用户意图的原因）', () => {
  assert.equal(
    resolveSteeringSend({ inFlight: true, text: '', hasAttachments: true, steeringAvailable: false }).reason,
    'empty'
  );
  assert.equal(
    resolveSteeringSend({ inFlight: true, text: 'x', hasAttachments: true, steeringAvailable: false }).reason,
    'attachments'
  );
});

test('坏输入安全：undefined / null / 非字符串文本都不抛', () => {
  assert.equal(resolveSteeringSend().action, STEERING_SEND_ACTIONS.SEND);
  assert.equal(resolveSteeringSend({ inFlight: true, text: undefined }).reason, 'empty');
  assert.equal(resolveSteeringSend({ inFlight: true, text: null }).reason, 'empty');
  assert.equal(resolveSteeringSend({ inFlight: true, text: 123 }).reason, 'noLoop', '数字文本非空，缺队列才是原因');
});

test('工作区发送回归：onPress={handleSend} 传的 press 事件不得被当正文（[object Object]）', () => {
  const src = fs.readFileSync(path.resolve('src/workspace/screen/ChatPanel.js'), 'utf8');
  // 整合后沿用 D 系写法：判据是「是字符串」才算覆盖（press 事件对象在此被挡下）。
  assert.ok(src.includes("typeof overrideText === 'string'"), 'overrideText 只认字符串（事件对象一律当无覆盖，用输入框内容）');
  assert.equal(
    /overrideText === undefined \? input : overrideText/.test(src),
    false,
    '旧的 undefined 判断已移除（它会放行 press 事件 → [object Object]）'
  );
});

// E 回归（2026-10-12）：pushSteering 失败必须留下可见提示。
//
// 症状：pushSteering 在「没有队列」或「入队被拒」时静默 return false。宿主（ChatScreen）
// 只在成功时才清空输入框 ⇒ 失败时用户看到的是「点了发送、字还在、什么也没发生」。
// 判定本身是纯函数（上面几条），这里钉的是**反馈**：两条失败路径都要 setSteeringNote。
test('pushSteering 失败路径必须给出可见提示（不许静默 return false）', () => {
  const src = fs.readFileSync(path.resolve('src', 'chat', 'useChatSend.js'), 'utf8');
  const at = src.indexOf('const pushSteering = useCallback(');
  assert.ok(at > 0, 'pushSteering 仍在');
  const body = src.slice(at, src.indexOf('}, []);', at));
  assert.ok(body.includes('setSteeringNote('), '失败也要写提示（steeringNote 是宿主渲染的那条）');
  assert.ok(body.includes('chat.send.steering.noLoop'), '复用已有的 noLoop 词条（不新增词条）');
  assert.ok(body.includes('chat.send.steering.note'), '成功路径仍报「已入队」');
  // 失败分支不得再是裸 return false（那就又回到静默）
  assert.equal(/if \(![^)]*\) return false;/.test(body), false, '失败分支不能再裸 return false');
});
