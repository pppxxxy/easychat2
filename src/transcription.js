// 语音转文字（STT）纯逻辑：配置规整、来源解析、请求构造与不支持错误判定。
//
// 回退顺序（需求 3）：
//   1. 用户配置了独立转写服务 → 用它；
//   2. 否则复用当前聊天 API 配置调 `{origin}/v1/audio/transcriptions`；
//   3. 端点不存在（404）等「不支持」→ 提示去配置独立转写；
//   4. 都不可用 → 调用方存占位文本 `[用户发来一段语音]`，不阻断发送。
//
// 本模块只做纯逻辑与 fetch 调用，不触碰 React / 存储；便于单测。

export const DEFAULT_TRANSCRIPTION_MODEL = 'whisper-1';

// 转写请求默认超时：调用方（录音发送）不传 signal，网络挂起时会永久卡住
// voiceBusy。这里在无外部 signal 时用内部 AbortController 兜底，超时即中断。
export const TRANSCRIPTION_TIMEOUT_MS = 60000;

// 转写端点固定在 v1 下，不复用聊天端点可能带的 /chat/completions 后缀。
// 复用聊天配置时按 chat baseUrl 推导 origin/base；独立配置则直接给定地址。
function stripSuffixes(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
}

// 把聊天 baseUrl 规整为转写端点：去掉 /chat/completions，再保证 /v1/audio/transcriptions。
export function buildTranscriptionUrl(baseUrl) {
  let base = stripSuffixes(baseUrl);
  if (/\/chat\/completions$/i.test(base)) base = base.replace(/\/chat\/completions$/i, '');
  if (/\/audio\/transcriptions$/i.test(base)) return base;
  if (/\/v1$/i.test(base)) return `${base}/audio/transcriptions`;
  return `${base}/v1/audio/transcriptions`;
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

// 判定「该来源不支持转写」：端点不存在（404）、或响应体明确说明无此能力。
// 这类结果会被调用方缓存，避免对必然失败的端点反复请求。
export function isUnsupportedTranscriptionError(error) {
  if (!error) return false;
  if (error.unsupported === true) return true;
  const status = Number(error.status);
  if (status === 404 || status === 405 || status === 501) return true;
  const message = String(error.message || '').toLowerCase();
  if (!message) return false;
  return (
    message.includes('not found')
    || message.includes('not supported')
    || message.includes('unsupported')
    || message.includes('does not exist')
    || message.includes('no such')
  );
}

// 转写音频。fileUri 为本地文件 uri；mime 默认 audio/m4a。
// 成功返回 { text }；失败抛错（带 status / unsupported 字段，供上层判定与降级）。
export async function transcribeAudio({ config, fileUri, mime = 'audio/m4a', signal, timeoutMs = TRANSCRIPTION_TIMEOUT_MS } = {}) {
  const target = config || {};
  if (!target.url) {
    const error = new Error('未配置语音转写服务');
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
      const timeoutError = new Error('转写请求超时，请检查网络后重试');
      timeoutError.status = 0;
      throw timeoutError;
    }
    const wrapped = new Error('转写请求失败，请检查网络');
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
    let message = `转写失败（HTTP ${response.status}）`;
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
    throw new Error('转写返回内容无法解析');
  }
  const text = String((parsed && parsed.text) || '').trim();
  if (!text) throw new Error('转写没有返回文字');
  return { text };
}
