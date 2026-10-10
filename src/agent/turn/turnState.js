// turn 状态机（Z 系采纳 #4，对照 zai-org/ZCode 的 turn-machine.ts）。
//
// 为什么要有它：agent 循环（agent/loop.js）是命令式的——「现在处于哪个阶段」靠一堆
// 局部变量隐式表达（round、streamedText、toolCalls 是否为空……）。一旦有人在错误
// 的时机改了流转顺序，没有东西会报错，bug 只会在真机上以奇怪的方式出现。
//
// 这里把阶段与合法转移**显式化**：非法转移直接抛 InvalidTurnPhase，纯函数、Node 直测。
// 循环只做「按当前状态推进阶段」，不再自己记账。
//
// 纯模块：零 import、零原生依赖。

export const TURN_PHASES = Object.freeze({
  idle: 'idle',
  processingInput: 'processing_input',
  awaitingModelResponse: 'awaiting_model_response',
  streaming: 'streaming',
  schedulingTools: 'scheduling_tools',
  executingTools: 'executing_tools',
  awaitingPermission: 'awaiting_permission',
  aggregatingResults: 'aggregating_results',
  completing: 'completing',
  error: 'error',
});

const P = TURN_PHASES;

// 合法转移表：只有列出的目标阶段才允许从当前阶段进入。
const TRANSITIONS = Object.freeze({
  [P.idle]: [P.processingInput],
  [P.processingInput]: [P.awaitingModelResponse, P.completing, P.error],
  [P.awaitingModelResponse]: [P.streaming, P.completing, P.error],
  [P.streaming]: [P.schedulingTools, P.aggregatingResults, P.completing, P.error],
  [P.schedulingTools]: [P.executingTools, P.awaitingPermission, P.error],
  [P.executingTools]: [P.aggregatingResults, P.awaitingPermission, P.error],
  [P.awaitingPermission]: [P.executingTools, P.error],
  [P.aggregatingResults]: [P.awaitingModelResponse, P.schedulingTools, P.completing, P.error],
  [P.completing]: [P.idle],
  [P.error]: [P.idle],
});

export function canTransitionTo(current, next) {
  const allowed = TRANSITIONS[current];
  return Array.isArray(allowed) && allowed.includes(next);
}

export function isTerminalPhase(phase) {
  return phase === P.completing || phase === P.error;
}

export function isWaitingPhase(phase) {
  return phase === P.awaitingModelResponse
    || phase === P.awaitingPermission
    || phase === P.executingTools;
}

export class InvalidTurnPhaseError extends Error {
  constructor(current, target) {
    super(`非法的 turn 阶段转移：${current} → ${target}`);
    this.name = 'InvalidTurnPhaseError';
    this.code = 'invalid_turn_phase';
    this.current = current;
    this.target = target;
  }
}

export function createTurnState({ id = '', sessionId = '', turnNumber = 1, input = '', now = Date.now() } = {}) {
  return {
    id: String(id || ''),
    sessionId: String(sessionId || ''),
    turnNumber: Number(turnNumber) || 1,
    phase: P.idle,
    input: String(input || ''),
    streamingContent: '',
    finalResponse: '',
    toolCalls: [],
    toolResults: [],
    pendingInputs: [],
    resultType: 'success',
    startedAt: now,
    completedAt: null,
  };
}

// 工具调用状态：scheduled → running → completed / failed / permission_denied。
function makeToolCall(call) {
  const source = call && typeof call === 'object' ? call : {};
  return {
    id: String(source.id || ''),
    name: String(source.name || ''),
    input: source.arguments === undefined ? source.input : source.arguments,
    status: 'scheduled',
    completedAt: null,
  };
}

export function createTurnMachine(state) {
  let current = state && typeof state === 'object' ? state : createTurnState();

  const transition = phase => {
    if (!canTransitionTo(current.phase, phase)) {
      throw new InvalidTurnPhaseError(current.phase, phase);
    }
    current = { ...current, phase };
    return current;
  };

  return {
    get state() {
      return current;
    },
    get phase() {
      return current.phase;
    },

    start() {
      return transition(P.processingInput);
    },
    startModelRequest() {
      // 首轮从 processingInput 进；工具轮从 aggregatingResults 再进模型请求。
      if (current.phase !== P.processingInput && current.phase !== P.aggregatingResults) {
        throw new InvalidTurnPhaseError(current.phase, P.awaitingModelResponse);
      }
      return transition(P.awaitingModelResponse);
    },
    receiveModelResponse(content) {
      const next = transition(P.streaming);
      current = { ...next, streamingContent: current.streamingContent + String(content || '') };
      return current;
    },
    scheduleTools(toolCalls) {
      const next = transition(P.schedulingTools);
      current = {
        ...next,
        toolCalls: (Array.isArray(toolCalls) ? toolCalls : []).map(makeToolCall),
      };
      return current;
    },
    startToolExecution() {
      const needsPermission = current.toolCalls.some(tc => tc.status === 'waiting_permission');
      const next = transition(needsPermission ? P.awaitingPermission : P.executingTools);
      current = {
        ...next,
        toolCalls: current.toolCalls.map(tc => (
          tc.status === 'waiting_permission'
            ? tc
            : { ...tc, status: 'running' }
        )),
      };
      return current;
    },
    completeTool(toolCallId, { success = true, content = '' } = {}) {
      const id = String(toolCallId || '');
      current = {
        ...current,
        toolCalls: current.toolCalls.map(tc => (
          tc.id === id
            ? { ...tc, status: success ? 'completed' : 'failed', completedAt: Date.now() }
            : tc
        )),
        toolResults: [...current.toolResults, { id, success: Boolean(success), content: String(content || '') }],
      };
      return current;
    },
    queuePendingInput(input) {
      current = { ...current, pendingInputs: [...current.pendingInputs, input] };
      return current;
    },
    drainPendingInputs() {
      const inputs = current.pendingInputs;
      current = { ...current, pendingInputs: [] };
      return inputs;
    },
    aggregateResults() {
      return transition(P.aggregatingResults);
    },
    complete(response = '', resultType = 'success') {
      const next = transition(P.completing);
      current = {
        ...next,
        finalResponse: String(response || ''),
        resultType,
        completedAt: Date.now(),
      };
      return current;
    },
    fail(error) {
      current = {
        ...current,
        phase: P.error,
        resultType: 'error',
        error: error || { type: 'error' },
        completedAt: Date.now(),
      };
      return current;
    },
    // 从当前状态算出下一个应到的阶段（工具循环的决策点），纯查询。
    getNextPhase() {
      const { phase, toolCalls, streamingContent } = current;
      if (phase === P.streaming && toolCalls.length > 0) return P.schedulingTools;
      if (phase === P.streaming && toolCalls.length === 0 && streamingContent) return P.completing;
      if (phase === P.executingTools) {
        const pending = toolCalls.filter(tc => tc.status === 'running' || tc.status === 'waiting_permission');
        if (pending.length === 0) return P.aggregatingResults;
      }
      if (phase === P.aggregatingResults) {
        const failed = toolCalls.filter(tc => tc.status === 'failed' || tc.status === 'permission_denied');
        return failed.length > 0 ? P.completing : P.awaitingModelResponse;
      }
      return phase;
    },
    isComplete() {
      return isTerminalPhase(current.phase);
    },
  };
}
