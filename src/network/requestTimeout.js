// 在线请求的「等多久算超时」策略（纯函数，零依赖，Node 直测）。
//
// 为什么单独一个模块：超时阈值与「失败怎么归类」是一体两面（降级链按结构化字段判
// 定，不看文案），把它从 api.js 的 XHR 回调里抽出来才能钉住行为——此前这里只有一个
// 布尔 `!sawFirstByte`，非流式请求被误判成「等首字节」，见下。
//
// 三个档位（api.js 的 armIdleTimer 用）：
//  · 流式 + 还没收到任何字节 —— 首字节等待。推理模型思考期间可能几十秒不吐字，
//    放宽到 FIRST_BYTE_TIMEOUT_MS，否则会误报「请求超时」。
//  · 流式 + 已开始收 —— 空闲等待。IDLE_TIMEOUT_MS 足够（吐字中卡住就是真卡住）。
//  · 非流式 —— 服务端要一次性算完整篇再回包，**从头到尾都没有「首字节」这回事**。
//    用首字节阈值会把它误判，用空闲阈值更离谱；给 NONSTREAM_TIMEOUT_MS。
//
// 2026-10-11 P1 修：此前 `waitingFirstByte = !sawFirstByte`，而 sawFirstByte 只在
// `stream === true` 的 onprogress 路径置位 —— 于是 stream:false 的请求阈值恒为
// FIRST_BYTE_TIMEOUT_MS（120s），文案也恒为「等待首个响应超时」。而**压缩摘要、
// 记忆总结、制卡都是 stream:false**（最慢的调用），超时后进降级链，每个模型再等 120s。

export const FIRST_BYTE_TIMEOUT_MS = 120000;
export const IDLE_TIMEOUT_MS = 30000;
// 非流式：服务端算完整篇才回包，没有首字节概念。取 300s（与「长任务」工具超时同量级）。
export const NONSTREAM_TIMEOUT_MS = 300000;

// 本次等待属于哪一档：'first-byte' | 'idle' | 'nonstream'。
export function timeoutPhase({ stream = true, sawFirstByte = false } = {}) {
  if (stream !== true) return 'nonstream';
  return sawFirstByte === true ? 'idle' : 'first-byte';
}

// 该档的阈值（毫秒）。
export function timeoutMsFor(phase) {
  if (phase === 'nonstream') return NONSTREAM_TIMEOUT_MS;
  if (phase === 'idle') return IDLE_TIMEOUT_MS;
  return FIRST_BYTE_TIMEOUT_MS;
}

// 超时错误文案：如实说清在等什么（「首个响应」与「非流式整包」是两件事）。
export function timeoutMessage(phase) {
  if (phase === 'nonstream') {
    return '等待响应超时（非流式请求需服务端算完整篇再回包），请检查网络或 API 地址，可稍后重试';
  }
  if (phase === 'idle') return '请求超时，请检查网络后重试';
  return '等待首个响应超时，请检查网络或 API 地址（推理模型可能较慢，可稍后重试）';
}

// 该档是否属于「等首字节」——降级链的 firstByte 标记用它（非流式不是首字节等待）。
export function isFirstBytePhase(phase) {
  return phase === 'first-byte';
}
