import { Buffer } from 'buffer';

import { TTS_MAX_CHARS, getTtsProvider } from './providers';
import { registerSecretValues } from '../secrets';

const DEFAULT_TIMEOUT_MS = 30000;

let speechModule;
let speechLoaded = false;
let audioModule;
let audioLoaded = false;

function getSpeechModule() {
  if (!speechLoaded) {
    speechLoaded = true;
    try {
      speechModule = require('expo-speech');
    } catch (error) {
      speechModule = null;
    }
  }
  return speechModule;
}

function getAudioModule() {
  if (!audioLoaded) {
    audioLoaded = true;
    try {
      audioModule = require('expo-av');
    } catch (error) {
      audioModule = null;
    }
  }
  return audioModule;
}

let currentSound = null;
let speakGeneration = 0;
let speakRequestId = 0;
let activeRequestController = null;
const tokenCache = new Map();

export function truncateText(text, maxChars = TTS_MAX_CHARS) {
  const source = String(text || '').trim();
  if (source.length <= maxChars) return source;
  return source.slice(0, maxChars);
}

export function mapHttpError(status) {
  if (status === 401 || status === 403) return '密钥无效或未授权';
  if (status === 429) return '请求过于频繁，请稍后重试';
  if (status === 404) return '接口地址不存在（404），请核对官方文档端点与服务地址';
  if (status === 400) return '请求被服务拒绝（400），请检查模型名与必填参数';
  return `播报失败（HTTP ${status}）`;
}

export function isSystemProvider(provider) {
  return Boolean(provider && provider.engine === 'system');
}

function getByPath(source, path) {
  if (!path) return undefined;
  return String(path).split('.').reduce((current, key) => {
    if (current === null || current === undefined) return undefined;
    return current[key];
  }, source);
}

function setByPath(target, path, value) {
  if (!path) return;
  const keys = String(path).split('.');
  let node = target;
  for (let index = 0; index < keys.length - 1; index += 1) {
    const key = keys[index];
    if (node[key] === undefined || node[key] === null || typeof node[key] !== 'object') {
      node[key] = {};
    }
    node = node[key];
  }
  node[keys[keys.length - 1]] = value;
}

function buildHeaders(provider, config) {
  const headers = {};
  const auth = provider.auth || {};
  if (auth.type === 'header' && auth.keyName) {
    const prefix = auth.prefix === undefined ? '' : auth.prefix;
    headers[auth.keyName] = `${prefix}${config.apiKey || ''}`;
  }
  // query 认证（如 MiniMax 的 GroupId）之外仍需 Bearer 密钥头的平台。
  // 没有这行，apiKey 会被收集却从不发送。
  if (auth.bearer && config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }
  return headers;
}

export function buildTtsRequest(provider, config, text, token) {
  const method = provider.method || 'POST';
  let url = String(config.baseUrl || provider.baseUrl || '').trim();
  if (!url) return null;
  if (!/^(?:https?|wss?):\/\/[^/\s]+/i.test(url)) {
    throw new Error('请填写有效的语音服务地址');
  }
  // XHR 无法打开 WebSocket 连接：wss 端点（如讯飞）直接明确失败，
  // 不要让用户面对一个难以理解的 XHR 网络错误。
  if (/^wss:/i.test(url)) {
    throw new Error('该语音服务使用 WebSocket 协议（wss），当前引擎暂不支持，请改用其他引擎或 HTTP 端点');
  }
  // 腾讯云需要 TC3-HMAC-SHA256 签名，当前引擎未实现：
  // 绝不把 SecretKey 当明文 Authorization 头发送（必然 401 且密钥暴露在头里），
  // 明确失败优于静默泄露。
  if (provider.signer === 'tencent') {
    throw new Error('腾讯云语音签名（TC3-HMAC-SHA256）尚未实现，暂时无法使用该引擎');
  }
  // 凭据前置校验：声明表按 optional 标注必填项，缺参直接本地报错——
  // 发出去只会得到服务端难懂的 401/400，用户无从知道缺哪个字段。
  (provider.fields || []).forEach(field => {
    if (!field || !field.key || field.key === 'baseUrl' || field.optional) return;
    const value = config[field.key];
    if (value === undefined || value === null || String(value).trim() === '') {
      throw new Error(`请先填写${field.label || field.key}`);
    }
  });
  // payloadDefaults 深拷贝后作为载荷基底：浅拷贝会让 setByPath 写穿到
  // 声明表本体（写入共享的嵌套对象），污染 TTS_PROVIDERS 常量。
  const payload = JSON.parse(JSON.stringify(provider.payloadDefaults || {}));
  if (provider.requestMode === 'chat') {
    // MiMo 等平台把 TTS 挂在 chat/completions 上：合成文本作为 assistant 消息，
    // 音频以 base64 返回在 choices[0].message.audio.data。
    setByPath(payload, 'messages', [{ role: 'assistant', content: text }]);
  } else if (provider.textField) {
    setByPath(payload, provider.textField, text);
  }
  if (provider.voiceField && config.voice) setByPath(payload, provider.voiceField, config.voice);
  if (provider.speedField && config.speed !== undefined && config.speed !== '') {
    const numeric = Number(config.speed);
    setByPath(payload, provider.speedField, Number.isFinite(numeric) ? numeric : config.speed);
  }
  if (provider.formatField && config.format) setByPath(payload, provider.formatField, config.format);
  if (config.model && provider.engine !== 'system') setByPath(payload, 'model', config.model);
  if (provider.appIdField && config.appId) setByPath(payload, provider.appIdField, config.appId);

  const headers = buildHeaders(provider, config);
  const auth = provider.auth || {};
  if (auth.type === 'query' && auth.keyName) {
    const join = url.includes('?') ? '&' : '?';
    url = `${url}${join}${encodeURIComponent(auth.keyName)}=${encodeURIComponent(config.appId || '')}`;
  }
  if (auth.type === 'token' && auth.keyName) {
    if (auth.tokenInBody) {
      // 百度官方 SDK 明确把令牌从查询串移进表单体（data['tok']=token 并删除
      // 查询参数）：令牌进 URL 会落入服务端与代理日志。
      setByPath(payload, auth.keyName, token || '');
    } else {
      const join = url.includes('?') ? '&' : '?';
      url = `${url}${join}${encodeURIComponent(auth.keyName)}=${encodeURIComponent(token || '')}`;
    }
  }
  if (auth.type === 'body' && auth.keyName) setByPath(payload, auth.keyName, config.apiKey || '');
  // 平台声明的额外查询参数（如阿里云 NLS 的 appkey）：
  // 只装配有值的字段，避免拼出 appkey= 的空参数。
  (provider.queryFields || []).forEach(field => {
    const raw = config[field.from];
    if (raw === undefined || raw === null || String(raw) === '') return;
    const join = url.includes('?') ? '&' : '?';
    url = `${url}${join}${encodeURIComponent(field.name)}=${encodeURIComponent(String(raw))}`;
  });

  if (provider.signer === 'iflytek') {
    if (config.appId) setByPath(payload, 'common.app_id', config.appId);
    setByPath(payload, 'business.aue', config.format || 'raw');
  } else if (provider.signer === 'tencent') {
    if (config.appId) setByPath(payload, 'SecretId', config.appId);
    setByPath(payload, 'Action', 'TextToVoice');
    if (config.region) setByPath(payload, 'Region', config.region);
  } else if (provider.signer === 'volcano') {
    if (config.appId) setByPath(payload, 'app.appid', config.appId);
    if (config.apiKey) setByPath(payload, 'app.token', config.apiKey);
    // 火山官方必填：cluster 固定 volcano_tts，user.uid 与 request.reqid/operation 缺一不可，
    // 否则服务端直接拒绝。
    setByPath(payload, 'app.cluster', 'volcano_tts');
    setByPath(payload, 'user.uid', 'easychat2');
    setByPath(payload, 'request.reqid', `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
    setByPath(payload, 'request.operation', 'query');
    if (getByPath(payload, 'request.text_type') === undefined) {
      setByPath(payload, 'request.text_type', 'plain');
    }
  }

  // 百度等平台要求表单提交：JSON 会被服务端按表单解析失败。
  if (provider.requestFormat === 'form') {
    const formBody = Object.entries(payload)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
      .join('&');
    return {
      method,
      url,
      headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody,
    };
  }

  return {
    method,
    url,
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  };
}

export async function resolveToken(provider, config, { now = Date.now(), signal = null } = {}) {
  const auth = provider.auth || {};
  if (auth.type !== 'token' || !auth.tokenUrl) return '';
  // 缓存键要带上凭据指纹：只按 provider.id 缓存，用户换了 Key/Secret 之后
  // 仍会复用旧令牌（部分服务商 TTL 长达 30 天），表现为“改了密钥还是失败”。
  const cacheKey = `${provider.id}\u0000${config.apiKey || ''}\u0000${config.appSecretKey || ''}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && (!cached.expiresAt || cached.expiresAt > now)) return cached.token;
  const body = {
    ...(auth.tokenFields || {}),
    client_id: config.apiKey || '',
    client_secret: config.appSecretKey || '',
  };
  const queryString = Object.entries(body)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
  // 凭据用 POST body（x-www-form-urlencoded）提交，不要拼进 URL：
  // 查询串会进入服务端日志、代理和错误回显。
  const data = await xhrJson({
    method: 'POST',
    url: auth.tokenUrl,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: queryString,
    signal,
  }).catch(error => {
    if (error && error.name === 'AbortError') throw error;
    // 令牌端点的 401/403 意味着密钥错误，400 意味着参数/密钥格式问题：
    // 用专属文案替代通用 mapHttpError（它会给"请检查模型名"这类无关建议）。
    throw new Error('令牌获取失败，请检查 API Key 与 Secret Key 是否正确');
  });
  const token = String(getByPath(data, auth.tokenPath || 'access_token') || '');
  if (!token) throw new Error('令牌获取失败');
  const ttl = Number(auth.tokenTtlSec) || 0;
  tokenCache.set(cacheKey, {
    token,
    expiresAt: ttl > 0 ? now + ttl * 1000 : 0,
  });
  return token;
}

function createTtsAbortError() {
  const error = new Error('播报已中断');
  error.name = 'AbortError';
  error.canceled = true;
  return error;
}

function arrayBufferToBase64(value) {
  const bytes = value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : new Uint8Array(value || 0);
  const parts = [];
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    let binary = '';
    for (let index = 0; index < chunk.length; index += 1) {
      binary += String.fromCharCode(chunk[index]);
    }
    parts.push(binary);
  }
  return Buffer.from(parts.join(''), 'binary').toString('base64');
}

// 部分服务（如百度）失败时仍返回 HTTP 200 + JSON 错误体。
// 从常见错误字段里提取真实原因，避免"音频数据无法解码"这类不可诊断的报错。
function extractServiceError(parsed) {
  if (!parsed || typeof parsed !== 'object') return '';
  const messageCandidates = [
    parsed.err_msg,
    parsed.error_msg,
    parsed.msg,
    parsed.message,
    parsed.base_resp && parsed.base_resp.status_msg,
    parsed.error && parsed.error.message,
    parsed.Error && parsed.Error.Message,
  ];
  for (const candidate of messageCandidates) {
    const text = String(candidate || '').trim();
    if (text) return `服务返回错误：${text.slice(0, 200)}`;
  }
  const codeCandidates = [
    parsed.err_no,
    parsed.errcode,
    parsed.code,
    parsed.base_resp && parsed.base_resp.status,
    parsed.Error && parsed.Error.Code,
  ];
  for (const candidate of codeCandidates) {
    if (candidate !== undefined && candidate !== null && String(candidate) !== '') {
      return `服务返回错误码：${String(candidate).slice(0, 100)}`;
    }
  }
  return '';
}

function xhrJson({ method, url, headers, body, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(createTtsAbortError());
      return;
    }
    const xhr = new XMLHttpRequest();
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        xhr.abort();
      } catch (error) {}
      reject(createTtsAbortError());
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        xhr.abort();
      } catch (error) {}
      reject(new Error('播报超时，请稍后重试'));
    }, timeoutMs || DEFAULT_TIMEOUT_MS);
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort);
      }
      fn(value);
    };
    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', onAbort, { once: true });
    }
    xhr.open(method || 'POST', url);
    Object.entries(headers || {}).forEach(([key, value]) => {
      try {
        xhr.setRequestHeader(key, value);
      } catch (error) {}
    });
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        finish(reject, new Error(mapHttpError(xhr.status)));
        return;
      }
      try {
        finish(resolve, JSON.parse(xhr.responseText || '{}'));
      } catch (error) {
        finish(reject, new Error('播报返回无法解析'));
      }
    };
    xhr.onerror = () => finish(reject, new Error('播报网络请求失败'));
    xhr.onabort = () => finish(reject, new Error('播报已中断'));
    try {
      xhr.send(body || null);
    } catch (error) {
      finish(reject, error);
    }
  });
}

function xhrAudio({ method, url, headers, body, timeoutMs, mode, path, signal }) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(createTtsAbortError());
      return;
    }
    const xhr = new XMLHttpRequest();
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        xhr.abort();
      } catch (error) {}
      reject(createTtsAbortError());
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        xhr.abort();
      } catch (error) {}
      reject(new Error('播报超时，请稍后重试'));
    }, timeoutMs || DEFAULT_TIMEOUT_MS);
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort);
      }
      fn(value);
    };
    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', onAbort, { once: true });
    }
    xhr.open(method || 'POST', url);
    if (mode !== 'base64') {
      try {
        xhr.responseType = 'arraybuffer';
      } catch (error) {}
    }
    Object.entries(headers || {}).forEach(([key, value]) => {
      try {
        xhr.setRequestHeader(key, value);
      } catch (error) {}
    });
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        finish(reject, new Error(mapHttpError(xhr.status)));
        return;
      }
      if (mode === 'base64' || mode === 'hex') {
        let raw = '';
        let parsed = null;
        try {
          parsed = JSON.parse(xhr.responseText || '{}');
          raw = String(getByPath(parsed, path) || '');
        } catch (error) {
          raw = '';
          parsed = null;
        }
        if (!raw) {
          const serviceError = extractServiceError(parsed);
          finish(reject, new Error(serviceError || '未获取到音频数据'));
          return;
        }
        // MiniMax 等平台的 audio 是 hex 编码（官方默认），按 base64 解会得到坏音频。
        if (mode === 'hex') {
          finish(resolve, { base64: Buffer.from(raw, 'hex').toString('base64') });
          return;
        }
        finish(resolve, { base64: raw });
        return;
      }
      const response = xhr.response;
      if (!response || (typeof response === 'string' && !response)) {
        finish(reject, new Error('未获取到音频数据'));
        return;
      }
      // HTTP 200 但实际是 JSON 错误体（百度常见）：音频二进制不会以 '{' 开头，
      // 命中则解析出真实错误，不再报"音频数据无法解码"。
      try {
        const bytes = response instanceof ArrayBuffer ? new Uint8Array(response) : null;
        if (bytes && bytes.length > 0 && bytes[0] === 0x7b) {
          const parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
          const serviceError = extractServiceError(parsed);
          if (serviceError) {
            finish(reject, new Error(serviceError));
            return;
          }
        }
      } catch (error) {}
      try {
        finish(resolve, { base64: arrayBufferToBase64(response) });
      } catch (error) {
        finish(reject, new Error('音频数据无法解码'));
      }
    };
    xhr.onerror = () => finish(reject, new Error('播报网络请求失败'));
    xhr.onabort = () => finish(reject, new Error('播报已中断'));
    try {
      xhr.send(body || null);
    } catch (error) {
      finish(reject, error);
    }
  });
}

export async function synthesize({ provider, config = {}, text, signal = null }) {
  const resolvedProvider = typeof provider === 'string' ? getTtsProvider(provider) : provider;
  if (!resolvedProvider) throw new Error('未知的播报服务');
  // 登记播报密钥：报错文本可能带出裸 Key/Secret
  registerSecretValues([config.apiKey, config.appSecretKey]);
  const content = truncateText(text, Number(resolvedProvider.maxChars) > 0
    ? Math.trunc(Number(resolvedProvider.maxChars))
    : TTS_MAX_CHARS);
  if (!content) throw new Error('没有可播报的内容');
  if (isSystemProvider(resolvedProvider)) return { mode: 'system', text: content };  const token = await resolveToken(resolvedProvider, config, { signal }).catch(error => {
    if (error && error.name === 'AbortError') throw error;
    // 令牌拿不到还发空令牌请求，只会得到难懂的 401/403：直接抛清楚原因。
    throw new Error(error && error.message ? error.message : '令牌获取失败');
  });
  const request = buildTtsRequest(resolvedProvider, config, content, token);
  if (!request) throw new Error('播报服务未配置接口地址');
  const response = resolvedProvider.response || {};
  const audio = await xhrAudio({
    ...request,
    timeoutMs: resolvedProvider.timeoutMs || DEFAULT_TIMEOUT_MS,
    mode: response.mode === 'base64' || response.mode === 'hex' ? response.mode : 'binary',
    path: response.path,
    signal,
  });
  return {
    mode: 'audio',
    base64: audio.base64,
    // 播放端按声明表的 responseMime 传给 expo-av；默认 mp3 与各家的
    // 显式格式请求（audio.format/format/encoding/aue）保持配套。
    mime: resolvedProvider.responseMime || 'audio/mp3',
  };
}

async function stopPlayback() {
  const controller = activeRequestController;
  activeRequestController = null;
  if (controller) {
    try {
      controller.abort();
    } catch (error) {}
  }
  const speech = getSpeechModule();
  if (speech && typeof speech.stop === 'function') {
    try {
      speech.stop();
    } catch (error) {}
  }
  if (currentSound) {
    const sound = currentSound;
    currentSound = null;
    try {
      await sound.stopAsync();
      await sound.unloadAsync();
    } catch (error) {}
  }
}

export async function stop() {
  speakRequestId += 1;
  speakGeneration += 1;
  return stopPlayback();
}

export async function speak({ provider, config = {}, text, onDone, onError }) {
  const resolvedProvider = typeof provider === 'string' ? getTtsProvider(provider) : provider;
  const requestId = ++speakRequestId;
  speakGeneration += 1;
  await stopPlayback();
  if (requestId !== speakRequestId) return;
  const token = speakGeneration;
  const controller = new AbortController();
  activeRequestController = controller;
  try {
    if (isSystemProvider(resolvedProvider)) {
      const speech = getSpeechModule();
      if (!speech || typeof speech.speak !== 'function') {
        throw new Error('当前设备不支持系统语音合成');
      }
      const content = truncateText(text);
      if (!content) throw new Error('没有可播报的内容');
      const options = {};
      if (config.voice) options.voice = config.voice;
      const speed = Number(config.speed);
      if (Number.isFinite(speed) && speed > 0) options.rate = speed;
      speech.speak(content, {
        ...options,
        onDone: () => {
          if (token === speakGeneration && onDone) onDone();
        },
        onError: error => {
          if (token === speakGeneration && onError) onError(error);
        },
      });
      return;
    }
    const result = await synthesize({ provider: resolvedProvider, config, text, signal: controller.signal });
    if (token !== speakGeneration) return;
    const audio = getAudioModule();
    if (!audio || !audio.Audio || typeof audio.Audio.Sound === 'undefined') {
      throw new Error('当前设备不支持音频播放');
    }
    const uri = `data:${result.mime || 'audio/mp3'};base64,${result.base64}`;
    const { sound } = await audio.Audio.Sound.createAsync({ uri });
    if (token !== speakGeneration) {
      try {
        await sound.unloadAsync();
      } catch (error) {}
      return;
    }
    currentSound = sound;
    sound.setOnPlaybackStatusUpdate(status => {
      if (status && status.didJustFinish) {
        if (token === speakGeneration && currentSound === sound) {
          if (onDone) onDone();
          stop();
        }
      }
    });
    await sound.playAsync();
  } catch (error) {
    if (token !== speakGeneration || (error && error.name === 'AbortError')) return;
    await stop();
    if (onError) onError(error);
    else throw error;
  } finally {
    if (activeRequestController === controller) activeRequestController = null;
  }
}
