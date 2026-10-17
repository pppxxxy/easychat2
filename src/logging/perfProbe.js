// 卡顿取证（perf probe）：只在**超标**时留一条诊断，默认关闭。
//
// 为什么需要它：这一轮排查里，「整体卡 / 越用越卡」在代码层找不到单一元凶——
// 渲染层（虚拟化 / memo / 样式）与存储层（JSON 开销实测 2000 条仅约 1ms）都已被验证过，
// 继续靠读代码猜下去只会瞎改。所以要能在**真机上量化**：哪一段慢、慢多少。
//
// 设计约束：
// - **默认关闭**（未启用时每个埋点函数立即返回，开销是一次布尔判断）；
// - 只在超过阈值时记录，不记录每一次（否则日志自己就成了瓶颈）；
// - 走既有 recordDiagnostic（自动脱敏 / 去重 / 只留 50 条）；
// - 样本只在内存里（上限 200 条），**不落盘**；落盘的只有「开关本身」这一个布尔
//   （storage/settings/perfProbe.js），启动时由 startup/perfProbeBootstrap.js 同步回来
//   ——真机上从开启到复现之间几乎必然要重启，开关不持久化就白开；
// - 纯 JS 计时（Date.now），本文件不引入任何原生依赖，Node 可测。
import { recordDiagnostic } from '../storage/diagnostics.js';

// 各段的默认阈值（ms）。超过才记。真机卡顿时这些值会明显被越过。
export const PERF_THRESHOLDS = Object.freeze({
  // 单帧渲染超过 50ms 就已经掉帧（16.7ms/帧），取 50 作为「用户能感觉到」的界。
  render: 50,
  // 存储读（getItem + JSON.parse）超过 120ms 会让一次页面切换明显迟滞。
  storageRead: 120,
  // 存储写（JSON.stringify + setItem）同上。
  storageWrite: 120,
  // 一次会话切换 / 冷启动阶段。
  startup: 800,
});

let enabled = false;
const samples = [];

// 开关（界面上由诊断面板接入；持久化在 storage/settings/perfProbe.js，启动时同步）。
// 返回是否启用成功。
export function setPerfProbeEnabled(value) {
  enabled = value === true;
  return enabled;
}

export function isPerfProbeEnabled() {
  return enabled;
}

// 本进程内的累计样本（仅供诊断面板/测试查看，不落盘）。
export function getPerfSamples() {
  return samples.slice();
}

// 清空样本（诊断面板的「清空样本」）。只清内存样本，**不动**诊断日志里
// 已经留下的那些条目——那些是 getDiagnostics 的地盘，由面板自己的「清空」按钮管。
export function clearPerfSamples() {
  const removed = samples.length;
  samples.length = 0;
  return removed;
}

// 面板展示用：把样本列表整理成「条数 + 最慢的一条」。抽出来是为了让面板本身保持
// 无逻辑（RN 组件在 Node 里没法测），而这段「谁最慢」的判定可以直测。
export function summarizePerfSamples(list = samples) {
  const items = Array.isArray(list) ? list.filter(item => item && typeof item.ms === 'number') : [];
  let worst = null;
  for (const item of items) {
    if (!worst || item.ms > worst.ms) worst = item;
  }
  return { count: items.length, worst };
}

export function __resetPerfProbeForTests() {
  enabled = false;
  samples.length = 0;
}

// 记一条样本：refreshed 用于让「同一段连续慢」在诊断里看得出次数。
function note(label, ms, threshold) {
  const sample = {
    label: String(label || ''),
    ms: Math.round(ms * 10) / 10,
    threshold,
    at: Date.now(),
  };
  samples.push(sample);
  // 内存里也只留最近 200 条，避免探针自己变成泄漏。
  if (samples.length > 200) samples.splice(0, samples.length - 200);
  recordDiagnostic(
    'log',
    { message: `[perf] ${sample.label} ${sample.ms}ms > ${threshold}ms` },
    'perf'
  );
  return sample;
}

// 同步计时一段同步代码（渲染、JSON 处理等）。未启用时零额外分配。
export function measureSync(label, fn, threshold = PERF_THRESHOLDS.render) {
  if (!enabled) return fn();
  const started = Date.now();
  try {
    return fn();
  } finally {
    const ms = Date.now() - started;
    if (ms > threshold) note(label, ms, threshold);
  }
}

// 计时一段异步代码（存储读写、网络）。失败也计时——慢的失败同样卡。
export async function measureAsync(label, fn, threshold = PERF_THRESHOLDS.storageRead) {
  if (!enabled) return fn();
  const started = Date.now();
  try {
    return await fn();
  } finally {
    const ms = Date.now() - started;
    if (ms > threshold) note(label, ms, threshold);
  }
}
