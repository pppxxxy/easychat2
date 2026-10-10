// turn 状态机（Z 系采纳 #4）：合法/非法转移、阶段推进、工具记账。纯函数直测。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TURN_PHASES as P,
  InvalidTurnPhaseError,
  canTransitionTo,
  createTurnMachine,
  createTurnState,
  isTerminalPhase,
  isWaitingPhase,
} from '../src/agent/turn/turnState.js';

test('createTurnState：默认从 idle 开始', () => {
  const state = createTurnState({ sessionId: 's1', turnNumber: 3, input: 'hi' });
  assert.equal(state.phase, P.idle);
  assert.equal(state.sessionId, 's1');
  assert.equal(state.turnNumber, 3);
  assert.deepEqual(state.toolCalls, []);
  assert.deepEqual(state.pendingInputs, []);
  assert.equal(state.resultType, 'success');
});

test('转移表：合法通过、非法拒绝', () => {
  assert.equal(canTransitionTo(P.idle, P.processingInput), true);
  assert.equal(canTransitionTo(P.idle, P.streaming), false);
  assert.equal(canTransitionTo(P.streaming, P.completing), true);
  assert.equal(canTransitionTo(P.completing, P.idle), true);
  assert.equal(canTransitionTo(P.aggregatingResults, P.awaitingModelResponse), true);
});

test('非法转移抛 InvalidTurnPhaseError（隐式状态变显式）', () => {
  const machine = createTurnMachine(createTurnState());
  assert.throws(() => machine.receiveModelResponse('x'), error => (
    error instanceof InvalidTurnPhaseError
    && error.code === 'invalid_turn_phase'
    && error.current === P.idle
    && error.target === P.streaming
  ));
});

test('纯文本一轮：idle → processing_input → awaiting_model_response → streaming → completing', () => {
  const machine = createTurnMachine(createTurnState());
  machine.start();
  assert.equal(machine.phase, P.processingInput);
  machine.startModelRequest();
  assert.equal(machine.phase, P.awaitingModelResponse);
  machine.receiveModelResponse('你好');
  assert.equal(machine.phase, P.streaming);
  machine.complete('你好');
  assert.equal(machine.phase, P.completing);
  assert.equal(machine.isComplete(), true);
  assert.equal(machine.state.finalResponse, '你好');
  assert.equal(machine.state.streamingContent, '你好');
});

test('工具一轮：scheduling → executing → 记账 → aggregating → 再进模型请求', () => {
  const machine = createTurnMachine(createTurnState());
  machine.start();
  machine.startModelRequest();
  machine.receiveModelResponse('');
  machine.scheduleTools([{ id: 'c1', name: 'read_workspace_file', arguments: '{}' }]);
  assert.equal(machine.phase, P.schedulingTools);
  assert.equal(machine.state.toolCalls[0].status, 'scheduled');
  machine.startToolExecution();
  assert.equal(machine.phase, P.executingTools);
  assert.equal(machine.state.toolCalls[0].status, 'running');
  machine.completeTool('c1', { success: true, content: 'OK' });
  assert.equal(machine.state.toolCalls[0].status, 'completed');
  assert.equal(machine.state.toolResults[0].success, true);
  machine.aggregateResults();
  assert.equal(machine.phase, P.aggregatingResults);
  // 工具轮之后允许再次发起模型请求
  machine.startModelRequest();
  assert.equal(machine.phase, P.awaitingModelResponse);
});

test('失败的工具标记为 failed', () => {
  const machine = createTurnMachine(createTurnState());
  machine.start();
  machine.startModelRequest();
  machine.receiveModelResponse('');
  machine.scheduleTools([{ id: 'c1', name: 'x' }]);
  machine.startToolExecution();
  machine.completeTool('c1', { success: false, content: 'boom' });
  assert.equal(machine.state.toolCalls[0].status, 'failed');
  assert.equal(machine.state.toolResults[0].success, false);
});

test('getNextPhase：streaming 有工具→scheduling，无工具有文本→completing', () => {
  const a = createTurnMachine(createTurnState());
  a.start();
  a.startModelRequest();
  a.receiveModelResponse('text');
  assert.equal(a.getNextPhase(), P.completing);
  a.scheduleTools([{ id: 'c1', name: 'x' }]);
  a.startToolExecution();
  assert.equal(a.getNextPhase(), P.executingTools);
  a.completeTool('c1', { success: true, content: '' });
  assert.equal(a.getNextPhase(), P.aggregatingResults);
});

test('pendingInputs：入队与排空', () => {
  const machine = createTurnMachine(createTurnState());
  machine.queuePendingInput({ text: '补充' });
  machine.queuePendingInput({ text: '再补充' });
  assert.equal(machine.state.pendingInputs.length, 2);
  const drained = machine.drainPendingInputs();
  assert.equal(drained.length, 2);
  assert.equal(machine.state.pendingInputs.length, 0);
});

test('fail：进入 error 阶段且 resultType=error', () => {
  const machine = createTurnMachine(createTurnState());
  machine.start();
  machine.fail({ type: 'cancelled' });
  assert.equal(machine.phase, P.error);
  assert.equal(machine.isComplete(), true);
  assert.equal(machine.state.resultType, 'error');
});

test('阶段谓词：终态与等待态', () => {
  assert.equal(isTerminalPhase(P.completing), true);
  assert.equal(isTerminalPhase(P.error), true);
  assert.equal(isTerminalPhase(P.streaming), false);
  assert.equal(isWaitingPhase(P.awaitingModelResponse), true);
  assert.equal(isWaitingPhase(P.executingTools), true);
  assert.equal(isWaitingPhase(P.awaitingPermission), true);
  assert.equal(isWaitingPhase(P.idle), false);
});
