// Local Dream（xororz/local-dream）端侧生图 HTTP 适配。
//
// 官方 API（见 ld-guide.chino.icu/features/http-api，backend main.cpp）：
// - 仅回环 127.0.0.1:8081，且必须先在 App 内加载模型后后端才开始监听；
// - POST /generate：JSON，返回 text/event-stream，事件有 progress / complete / error；
//   complete.image 是 base64 **裸 RGB**（channels=3），需自行编码为 PNG；
// - POST /tokenize：检查 prompt 是否超过 CLIP 77 token 上限。
//
// 本模块的纯逻辑（请求构造 / SSE 解析 / 事件归一）Node 可测；流式 XHR 由
// index.js 用内置 XMLHttpRequest 驱动（RN 无 fetch 流，沿用 api.js 的既有做法）。

import { decodeBase64ToBytes, encodePngBase64FromRgb } from './png.js';

export const LOCAL_DREAM_DEFAULT_URL = 'http://127.0.0.1:8081';
export const LOCAL_DREAM_GENERATE_PATH = '/generate';
export const LOCAL_DREAM_TOKENIZE_PATH = '/tokenize';

// 后端接受的 scheduler 取值（未知值会回落 dpm）。UI 侧若给出其它值，这里映射到
// 最接近的受支持项，避免把无效值直接发给后端。
const SCHEDULER_ALIASES = {
  'dpm++ 2m': 'dpm',
  'dpm++2m': 'dpm',
  dpm: 'dpm',
  dpmpp_2m: 'dpm',
  'dpm++ 2m karras': 'dpm_karras',
  dpm_karras: 'dpm_karras',
  'dpm++ 2m sde': 'dpm_sde',
  dpm_sde: 'dpm_sde',
  'dpm++ 2m sde karras': 'dpm_sde_karras',
  dpm_sde_karras: 'dpm_sde_karras',
  'euler a': 'euler_a',
  eulera: 'euler_a',
  euler_a: 'euler_a',
  'euler a karras': 'euler_a_karras',
  euler_a_karras: 'euler_a_karras',
  euler: 'euler',
  euler_karras: 'euler_karras',
  lcm: 'lcm',
};

export function normalizeLocalDreamScheduler(value) {
  const key = String(value || '').trim().toLowerCase();
  if (!key) return 'dpm';
  return SCHEDULER_ALIASES[key] || 'dpm';
}

// 解析 "1024*1792" / "1024x1792" → { width, height }；仅方形或缺失时给出 size。
export function parseLocalDreamSize(value) {
  const raw = String(value || '').trim().replace('*', 'x');
  const match = raw.match(/^(\d{2,5})x(\d{2,5})$/i);
  if (!match) return { size: 512 };
  const width = Math.round(Number(match[1]));
  const height = Math.round(Number(match[2]));
  if (!(width > 0) || !(height > 0)) return { size: 512 };
  if (width === height) return { size: width };
  return { width, height };
}

// Local Dream 要求尺寸是 8 的倍数（NPU 模式还必须与进入模型时选的分别一致）。
// 归一化到 8 的倍数，避免后端运行期报错。
function roundTo8(value) {
  const rounded = Math.round(Number(value) / 8) * 8;
  return Math.max(8, rounded);
}

// 构造 /generate 请求体。字段与官方文档一致。
export function buildLocalDreamBody({
  prompt,
  negativePrompt,
  steps,
  cfg,
  seed,
  size,
  image,
  mask,
  denoiseStrength,
  scheduler,
  aspectRatio,
} = {}) {
  const body = {
    prompt: String(prompt || ''),
    negative_prompt: String(negativePrompt || ''),
  };
  const resolvedSteps = Math.trunc(Number(steps));
  body.steps = Number.isFinite(resolvedSteps) && resolvedSteps > 0 ? Math.min(resolvedSteps, 150) : 20;
  const resolvedCfg = Number(cfg);
  body.cfg = Number.isFinite(resolvedCfg) && resolvedCfg > 0 ? resolvedCfg : 7.5;
  if (seed !== undefined && seed !== null && seed !== '') {
    const parsedSeed = Math.trunc(Number(seed));
    if (Number.isFinite(parsedSeed) && parsedSeed >= 0) body.seed = parsedSeed;
  }
  const dimensions = parseLocalDreamSize(size);
  if (dimensions.size) {
    body.size = roundTo8(dimensions.size);
  } else {
    body.width = roundTo8(dimensions.width);
    body.height = roundTo8(dimensions.height);
  }
  const normalizedScheduler = normalizeLocalDreamScheduler(scheduler);
  if (normalizedScheduler) body.scheduler = normalizedScheduler;
  if (aspectRatio) body.aspect_ratio = String(aspectRatio);
  // image 存在即 img2img；mask 存在即 inpaint。
  if (image) {
    body.image = String(image);
    const strength = Number(denoiseStrength);
    body.denoise_strength = Number.isFinite(strength) && strength > 0 && strength <= 1 ? strength : 0.6;
    if (mask) body.mask = String(mask);
  }
  return body;
}

// 生成 URL：baseUrl 允许用户填到 /generate 或根地址，统一归一。
export function localDreamEndpoint(baseUrl, path) {
  const base = String(baseUrl || LOCAL_DREAM_DEFAULT_URL).trim().replace(/\/+$/, '');
  if (!base) return `${LOCAL_DREAM_DEFAULT_URL}${path}`;
  if (base.toLowerCase().endsWith(path.toLowerCase())) return base;
  return `${base}${path}`;
}

// 把一条 SSE 事件的 type 归一为 { type, payload }。
export function parseLocalDreamEvent(dataText) {
  const text = String(dataText || '').trim();
  if (!text) return null;
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  const type = String(payload.type || '').trim();
  if (type === 'progress') {
    const step = Number(payload.step);
    const total = Number(payload.total_steps);
    return {
      type: 'progress',
      step: Number.isFinite(step) ? step : 0,
      totalSteps: Number.isFinite(total) && total > 0 ? total : 0,
      percent: Number.isFinite(step) && Number.isFinite(total) && total > 0
        ? Math.max(0, Math.min(100, Math.round((step / total) * 100)))
        : null,
    };
  }
  if (type === 'complete') {
    return {
      type: 'complete',
      image: String(payload.image || ''),
      seed: payload.seed,
      width: Math.trunc(Number(payload.width)) || 0,
      height: Math.trunc(Number(payload.height)) || 0,
      channels: Math.trunc(Number(payload.channels)) || 3,
      generationTimeMs: Number(payload.generation_time_ms) || 0,
    };
  }
  if (type === 'error') {
    return { type: 'error', message: String(payload.message || '生成失败') };
  }
  return null;
}

// 流式 SSE 解析器：多次 push 累积的 responseText 片段，按 SSE 规范「空行分隔事件、
// 同一事件多个 data: 行换行拼接」，逐事件回调。与 api.js 的多行 data 处理同构，
// 但这里只需要拿到完整 payload 文本再交给 parseLocalDreamEvent。
export function createLocalDreamSseParser(onEvent) {
  let consumed = 0;
  let lineBuffer = '';
  let dataLines = [];
  return {
    // 传入新的 responseText 累积串；只处理新增部分。
    push(fullText) {
      const incoming = String(fullText || '').slice(consumed);
      if (!incoming) return;
      consumed = String(fullText || '').length;
      lineBuffer += incoming;
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.replace(/\r$/, '').trim();
        if (!trimmed) {
          if (dataLines.length) {
            const event = parseLocalDreamEvent(dataLines.join('\n'));
            dataLines = [];
            if (event && typeof onEvent === 'function') onEvent(event);
          }
          continue;
        }
        if (trimmed.startsWith(':')) continue;
        if (!trimmed.startsWith('data:')) continue;
        dataLines.push(trimmed.slice(5).trim());
      }
    },
    // 流结束时冲刷未以空行收尾的最后一个事件。
    flush() {
      if (lineBuffer) {
        const trimmed = lineBuffer.replace(/\r$/, '').trim();
        lineBuffer = '';
        if (trimmed.startsWith('data:')) dataLines.push(trimmed.slice(5).trim());
      }
      if (dataLines.length) {
        const event = parseLocalDreamEvent(dataLines.join('\n'));
        dataLines = [];
        if (event && typeof onEvent === 'function') onEvent(event);
      }
    },
  };
}

// complete 事件 → 现有生图结果形状（{ base64 }）。裸 RGB/RGBA 编码为 PNG base64。
export function completeEventToImage(event) {
  const bytes = decodeBase64ToBytes(event && event.image);
  const width = Math.trunc(Number(event && event.width)) || 0;
  const height = Math.trunc(Number(event && event.height)) || 0;
  const channels = Math.trunc(Number(event && event.channels)) || 3;
  const base64 = encodePngBase64FromRgb(bytes, width, height, channels);
  return { base64, mimeType: 'image/png' };
}

// 连接失败的人话引导：Local Dream 后端只在加载模型后才监听，被拒多半是没开/没加载。
export function describeLocalDreamNetworkError(error) {
  const message = String((error && error.message) || error || '');
  if (/无法连接|Network request failed|连接|refused|ECONNREFUSED/i.test(message)) {
    return '无法连接本地 Local Dream（默认 127.0.0.1:8081）。请先打开 Local Dream、加载一个模型，确认 HTTP API 已开启后重试。';
  }
  return message || '本地生图请求失败';
}
