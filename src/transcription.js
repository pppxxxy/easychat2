// 语音转文字（STT）纯逻辑：配置规整、来源解析、请求构造与不支持错误判定。
//
// 回退顺序（需求 3）：
//   1. 用户配置了独立转写服务 → 用它；
//   2. 否则复用当前聊天 API 配置调 `{origin}/v1/audio/transcriptions`；
//   3. 端点不存在（404）等「不支持」→ 提示去配置独立转写；
//   4. 都不可用 → 调用方存占位文本 `[用户发来一段语音]`，不阻断发送。
//
// 本模块只做纯逻辑与 fetch 调用，不触碰 React / 存储；便于单测。

import { tActive } from './i18n/index.js';
import { joinUrlQuery, splitUrlQuery } from './utils/urlQuery.js';

export const DEFAULT_TRANSCRIPTION_MODEL = 'whisper-1';

// 转写请求默认超时：调用方（录音发送）不传 signal，网络挂起时会永久卡住
// voiceBusy。这里在无外部 signal 时用内部 AbortController 兜底，超时即中断。
export const TRANSCRIPTION_TIMEOUT_MS = 60000;

// 转写端点固定在 v1 下，不复用聊天端点可能带的 /chat/completions 后缀。
// 独立配置直接给定地址；复用聊天配置时由 buildTranscriptionUrl 从 baseUrl 推导。
// ⚠️ 注释按**实现**写（此前注释称「推导 origin/base」，实现却从没取过 origin，只是
// 字符串拼接）：这里刻意**不提取 origin**——聊天 baseUrl 可能带路径前缀（如 Azure 的
// /openai/deployments/<d>），提到 origin 会把前缀丢掉、把请求打到错误的服务上。
function stripSuffixes(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
}

// 把聊天 baseUrl 规整为转写端点：去掉 /chat/completions，再保证 /v1/audio/transcriptions。
// 后缀判定只看「路径」部分（先例：src/vectorMemory/providers.js:41-48）：整串判定时，
// 带 query 的地址（.../chat/completions?api-version=…）必然不中，转写端点会被追加进
// query 值 → 404。回拼时 query 原样接回，幂等。
export function buildTranscriptionUrl(baseUrl) {
  const { path, query } = splitUrlQuery(stripSuffixes(baseUrl));
  let base = path;
  if (/\/chat\/completions$/i.test(base)) base = base.replace(/\/chat\/completions$/i, '');
  if (/\/audio\/transcriptions$/i.test(base)) return joinUrlQuery(base, query);
  if (/\/v1$/i.test(base)) return joinUrlQuery(`${base}/audio/transcriptions`, query);
  return joinUrlQuery(`${base}/v1/audio/transcriptions`, query);
}

export function normalizeTranscriptionConfig(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    id: String(source.id || ''),
    name: String(source.name || '').trim(),
    baseUrl: stripSuffixes(source.baseUrl),
    apiKey: String(source.apiKey || ''),
    model: String(source.model || '').trim() || DEFAULT_TRANSCRIPTION_MODEL,
  };
}

// 解析本次要用的转写来源。
// 入参：chatConfig（当前聊天 API 配置，可空）、dedicated（独立转写配置，可空）。
// 返回 { source: 'dedicated'|'reused'|'none', baseUrl, apiKey, model, url }。
export function resolveTranscription({ chatConfig = null, dedicated = null } = {}) {
  const ded = dedicated
    ? normalizeTranscriptionConfig(dedicated)
    : null;
  if (ded && ded.baseUrl && ded.apiKey) {
    return {
      source: 'dedicated',
      baseUrl: ded.baseUrl,
      apiKey: ded.apiKey,
      model: ded.model,
      url: buildTranscriptionUrl(ded.baseUrl),
    };
  }
  const chat = normalizeTranscriptionConfig(chatConfig);
  if (chat.baseUrl && chat.apiKey) {
    return {
      source: 'reused',
      baseUrl: chat.baseUrl,
      apiKey: chat.apiKey,
      model: chat.model || DEFAULT_TRANSCRIPTION_MODEL,
      url: buildTranscriptionUrl(chat.baseUrl),
    };
  }
  return { source: 'none', baseUrl: '', apiKey: '', model: DEFAULT_TRANSCRIPTION_MODEL, url: '' };
}

// 「该来源不支持转写」的机器可读标记：错误对象置 error.unsupported = true，或
// error.code = TRANSCRIPTION_UNSUPPORTED_CODE。分类**只看结构化标记**，不看文案——
// 先例 src/network/api.js:51-53（configChangedError「文案走 i18n，分类判定改看 code」）。
export const TRANSCRIPTION_UNSUPPORTED_CODE = 'TRANSCRIPTION_UNSUPPORTED';

// 判定「该来源不支持转写」：端点不存在/未实现（404/405/501），或错误自带结构化标记。
// 这类结果会被调用方缓存（见 ChatScreen 的 transcriptionSupportedRef），避免对必然失败的
// 端点反复请求——**正因为它会被缓存，判据必须保守**：
// 旧实现还匹配 message 里的 'not found'/'unsupported'/'no such' 等子串，于是任意 400/500
// 的 {"error":{"message":"model not found"}}（模型名写错、配额/鉴权类错误常长这样）都被判成
// 「该来源不支持转写」→ 该会话此后每条语音直接跳过转写且不弹提示，只有占位文本发出；
// 而提示文案又正好叫用户「去设置里新增独立转写配置」——配好后同一会话仍被跳过。
// 文案是服务端自由文本，永远不能当判据；状态码与显式标记才是。
export function isUnsupportedTranscriptionError(error) {
  if (!error) return false;
  if (error.unsupported === true) return true;
  if (error.code === TRANSCRIPTION_UNSUPPORTED_CODE) return true;
  const status = Number(error.status);
  return status === 404 || status === 405 || status === 501;
}

// 转写音频。fileUri 为本地文件 uri；mime 默认 audio/m4a。
// 成功返回 { text }；失败抛错（带 status / unsupported 字段，供上层判定与降级）。
export async function transcribeAudio({ config, fileUri, mime = 'audio/m4a', signal, timeoutMs = TRANSCRIPTION_TIMEOUT_MS } = {}) {
  const target = config || {};
  if (!target.url) {
    const error = new Error(tActive('error.transcription.notConfigured'));
    error.unsupported = true;
    throw error;
  }
  const name = String(fileUri || '').split('/').pop() || 'voice.m4a';
  const form = new FormData();
  // RN 的 FormData 用 { uri, name, type } 描述文件；Web 端需要 Blob，这里按移动端约定。
  form.append('file', { uri: String(fileUri || ''), name, type: String(mime || 'audio/m4a') });
  form.append('model', String(target.model || DEFAULT_TRANSCRIPTION_MODEL));

  let response;
  // 超时兜底：外部 signal（若有）与内部超时控制器联动；两者任一触发都会中断 fetch。
  const timeoutController = new AbortController();
  const timeoutTimer = setTimeout(() => timeoutController.abort(), timeoutMs);
  const onExternalAbort = () => timeoutController.abort();
  if (signal) {
    if (signal.aborted) timeoutController.abort();
    else signal.addEventListener('abort', onExternalAbort, { once: true });
  }
  try {
    response = await fetch(target.url, {
      method: 'POST',
      headers: target.apiKey ? { Authorization: `Bearer ${target.apiKey}` } : {},
      body: form,
      signal: timeoutController.signal,
    });
  } catch (error) {
    if (error && error.name === 'AbortError') {
      // 外部 signal 主动取消：原样抛出，调用方按取消处理。
      if (signal && signal.aborted) throw error;
      // 否则是内部超时兜底：给出可诊断文案。
      const timeoutError = new Error(tActive('error.transcription.timeout'));
      timeoutError.status = 0;
      throw timeoutError;
    }
    const wrapped = new Error(tActive('error.transcription.networkFailed'));
    wrapped.cause = error;
    throw wrapped;
  } finally {
    clearTimeout(timeoutTimer);
    if (signal && typeof signal.removeEventListener === 'function') {
      signal.removeEventListener('abort', onExternalAbort);
    }
  }

  const bodyText = await response.text().catch(() => '');
  if (!response.ok) {
    let message = tActive('error.transcription.httpFailed', { status: response.status });
    try {
      const data = JSON.parse(bodyText);
      // error 可能是 {message}、纯字符串或无 message 的对象：最后一种直接
      // String 会显示成 "[object Object]"，此时回退 HTTP 状态文案更可诊断。
      message = data.error?.message
        || data.message
        || (typeof data.error === 'string' && data.error)
        || message;
    } catch (parseError) {}
    const error = new Error(String(message));
    error.status = response.status;
    throw error;
  }

  let parsed = null;
  try {
    parsed = JSON.parse(bodyText);
  } catch (parseError) {
    throw new Error(tActive('error.transcription.parseFailed'));
  }
  const text = String((parsed && parsed.text) || '').trim();
  if (!text) throw new Error(tActive('error.transcription.emptyResult'));
  return { text };
}
