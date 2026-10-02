// 本地模型运行日志：内存环形缓冲 + 错误分类，纯函数不依赖 RN/Expo，便于单测。
// 与 diagnostics.js 的分工：这里是高频、易失的本地模型事件（加载/推理/服务），
// 只保留最近若干条供面板即时查看；错误级由调用方额外写入 diagnostics 持久化脱敏日志。

export const MAX_MODEL_LOGS = 200;
export const MODEL_LOG_LEVELS = ['info', 'warn', 'error'];
const MAX_FIELD_CHARS = 2000;

let logs = [];

function clean(value) {
  if (value === null || value === undefined) return '';
  return String(value);
}

function truncate(text) {
  const value = clean(text);
  return value.length > MAX_FIELD_CHARS ? value.slice(0, MAX_FIELD_CHARS) : value;
}

function normalizeLevel(level) {
  const value = clean(level).trim().toLowerCase();
  return MODEL_LOG_LEVELS.includes(value) ? value : 'info';
}

export function normalizeModelLog(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const at = Number(source.at);
  return {
    at: Number.isFinite(at) && at > 0 ? at : Date.now(),
    level: normalizeLevel(source.level),
    event: truncate(source.event || 'event'),
    message: truncate(source.message || ''),
    context: truncate(source.context || ''),
  };
}

// 记录一条本地模型日志；超过上限丢弃最旧的。返回写入的规范条目。
export function recordModelLog(event, message = '', { level = 'info', context = '', at = Date.now() } = {}) {
  const entry = normalizeModelLog({ at, level, event, message, context });
  logs = [...logs, entry].slice(-MAX_MODEL_LOGS);
  return entry;
}

export function getModelLogs() {
  return logs.map(entry => ({ ...entry }));
}

export function clearModelLogs() {
  logs = [];
}

export function formatModelLogs(list) {
  const entries = (Array.isArray(list) ? list : []).map(normalizeModelLog);
  if (entries.length === 0) return '';
  return entries
    .map(entry => {
      const time = new Date(entry.at).toISOString();
      const lines = [`[${time}] ${entry.level} ${entry.event}: ${entry.message}`];
      if (entry.context) lines.push(`  context: ${entry.context}`);
      return lines.join('\n');
    })
    .join('\n');
}

// 人类可读的体积（用于日志里展示模型文件大小 / 设备内存）。
export function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size >= 10 || index === 0 ? Math.round(size) : size.toFixed(1)}${units[index]}`;
}

// 把错误整理成可定位的文本：保留 name/code（原生库常把真实原因放在这里，
// 只取 message 会丢失关键信息），并带上堆栈的首行调用点。
export function describeModelError(error) {
  if (error === null || error === undefined) return '未知错误';
  if (typeof error === 'string') return error;
  const name = clean(error.name);
  const code = clean(error.code);
  const message = clean(error.message);
  // 泛型 Error 的 name 无信息量，不前缀，避免「Error: xxx」噪声；原生库的
  // 自定义 name（如 LlamaError）与 code 才是定位关键，优先保留。
  const label = [name && name !== 'Error' ? name : '', code].filter(Boolean).join('/');
  const base = message || label || '未知错误';
  if (!label || base.includes(label)) return base;
  return `${label}: ${base}`;
}

// 错误分类：统一 code/level/message，供 UI 与回退逻辑判断。
export function classifyLocalModelError(error) {
  const name = clean(error && error.name);
  const code = clean(error && error.code);
  const message = clean(
    error && error.message !== undefined ? error.message : (typeof error === 'string' ? error : '')
  );
  if (name === 'AbortError' || code === 'ABORT_ERR' || code === 'ABORTED') {
    return { code: 'ABORTED', level: 'info', message: message || '本地模型请求已取消' };
  }
  if (code === 'LOCAL_MODEL_UNAVAILABLE') {
    return { code, level: 'warn', message: message || '当前构建未包含本地模型能力' };
  }
  if (code === 'RESOURCE_BUSY') {
    return { code, level: 'warn', message: message || '本地模型资源被占用' };
  }
  if (code === 'LOAD_FAILED' || code === 'INFERENCE_FAILED') {
    return { code, level: 'error', message: message || '本地模型推理失败' };
  }
  if (!message) return { code: 'UNKNOWN', level: 'error', message: '本地模型未知错误' };
  return { code: 'UNKNOWN', level: 'error', message };
}

// 仅测试用：清空缓冲。
export function __resetModelLogsForTests() {
  logs = [];
}
