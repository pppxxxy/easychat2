import { TTS_MAX_CHARS, getTtsProvider } from './providers';

const DEFAULT_TIMEOUT_MS = 30000;

let speechModule = null;
let audioModule = null;
try {
  speechModule = require('expo-speech');
} catch (error) {
  speechModule = null;
}
try {
  audioModule = require('expo-av');
} catch (error) {
  audioModule = null;
}

let currentSound = null;
const tokenCache = new Map();

export function truncateText(text, maxChars = TTS_MAX_CHARS) {
  const source = String(text || '').trim();
  if (source.length <= maxChars) return source;
  return source.slice(0, maxChars);
}

export function mapHttpError(status) {
  if (status === 401 || status === 403) return '密钥无效或未授权';
  if (status === 429) return '请求过于频繁，请稍后重试';
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
  return headers;
}

export function buildTtsRequest(provider, config, text, token) {
  const method = provider.method || 'POST';
  let url = String(config.baseUrl || provider.baseUrl || '').trim();
  if (!url) return null;
  const payload = {};
  if (provider.textField) setByPath(payload, provider.textField, text);
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
    const join = url.includes('?') ? '&' : '?';
    url = `${url}${join}${encodeURIComponent(auth.keyName)}=${encodeURIComponent(token || '')}`;
  }
  if (auth.type === 'body' && auth.keyName) setByPath(payload, auth.keyName, config.apiKey || '');

  if (provider.signer === 'iflytek') {
    if (config.appId) setByPath(payload, 'common.app_id', config.appId);
    setByPath(payload, 'business.aue', config.format || 'raw');
  } else if (provider.signer === 'tencent') {
    if (config.appId) setByPath(payload, 'SecretId', config.appId);
    setByPath(payload, 'Action', 'TextToVoice');
    if (config.region) setByPath(payload, 'Region', config.region);
  } else if (provider.signer === 'volcano') {
    if (config.appId) setByPath(payload, 'app.appid', config.appId);
    if (config.apiKey) {
      try {
        setByPath(payload, 'app.token', config.apiKey);
      } catch (error) {}
    }
  }

  return {
    method,
    url,
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  };
}

export async function resolveToken(provider, config, { now = Date.now() } = {}) {
  const auth = provider.auth || {};
  if (auth.type !== 'token' || !auth.tokenUrl) return '';
  const cached = tokenCache.get(provider.id);
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
  const url = `${auth.tokenUrl}?${queryString}`;
  const data = await xhrJson({ method: 'POST', url, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: null });
  const token = String(getByPath(data, auth.tokenPath || 'access_token') || '');
  if (!token) throw new Error('令牌获取失败');
  const ttl = Number(auth.tokenTtlSec) || 0;
  tokenCache.set(provider.id, {
    token,
    expiresAt: ttl > 0 ? now + ttl * 1000 : 0,
  });
  return token;
}

export function clearTokenCache() {
  tokenCache.clear();
}

function xhrJson({ method, url, headers, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
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
      fn(value);
    };
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

function xhrAudio({ method, url, headers, body, timeoutMs, mode, path }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
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
      fn(value);
    };
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
      const raw = xhr.responseText || '';
      if (mode === 'base64') {
        let base64 = '';
        try {
          const parsed = JSON.parse(raw);
          base64 = String(getByPath(parsed, path) || '');
        } catch (error) {
          base64 = '';
        }
        if (!base64) {
          finish(reject, new Error('未获取到音频数据'));
          return;
        }
        finish(resolve, { base64 });
        return;
      }
      if (!raw) {
        finish(reject, new Error('未获取到音频数据'));
        return;
      }
      finish(resolve, { base64: raw });
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

export async function synthesize({ provider, config = {}, text }) {
  const resolvedProvider = typeof provider === 'string' ? getTtsProvider(provider) : provider;
  if (!resolvedProvider) throw new Error('未知的播报服务');
  const content = truncateText(text);
  if (!content) throw new Error('没有可播报的内容');
  if (isSystemProvider(resolvedProvider)) return { mode: 'system', text: content };
  const token = await resolveToken(resolvedProvider, config).catch(() => '');
  const request = buildTtsRequest(resolvedProvider, config, content, token);
  if (!request) throw new Error('播报服务未配置接口地址');
  const response = resolvedProvider.response || {};
  const audio = await xhrAudio({
    ...request,
    timeoutMs: resolvedProvider.timeoutMs || DEFAULT_TIMEOUT_MS,
    mode: response.mode === 'base64' ? 'base64' : 'binary',
    path: response.path,
  });
  return { mode: 'audio', base64: audio.base64 };
}

export async function stop() {
  if (speechModule && typeof speechModule.stop === 'function') {
    try {
      speechModule.stop();
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

export async function speak({ provider, config = {}, text, onDone, onError }) {
  const resolvedProvider = typeof provider === 'string' ? getTtsProvider(provider) : provider;
  await stop();
  try {
    if (isSystemProvider(resolvedProvider)) {
      if (!speechModule || typeof speechModule.speak !== 'function') {
        throw new Error('当前设备不支持系统语音合成');
      }
      const content = truncateText(text);
      if (!content) throw new Error('没有可播报的内容');
      const options = {};
      if (config.voice) options.voice = config.voice;
      const speed = Number(config.speed);
      if (Number.isFinite(speed) && speed > 0) options.rate = speed;
      speechModule.speak(content, {
        ...options,
        onDone: () => onDone && onDone(),
        onError: error => {
          if (onError) onError(error);
        },
      });
      return;
    }
    const result = await synthesize({ provider: resolvedProvider, config, text });
    if (!audioModule || !audioModule.Audio || typeof audioModule.Audio.Sound === 'undefined') {
      throw new Error('当前设备不支持音频播放');
    }
    const uri = `data:audio/mp3;base64,${result.base64}`;
    const { sound } = await audioModule.Audio.Sound.createAsync({ uri });
    currentSound = sound;
    sound.setOnPlaybackStatusUpdate(status => {
      if (status && status.didJustFinish) {
        stop();
        if (onDone) onDone();
      }
    });
    await sound.playAsync();
  } catch (error) {
    await stop();
    if (onError) onError(error);
    else throw error;
  }
}

export async function listVoices(provider) {
  const resolvedProvider = typeof provider === 'string' ? getTtsProvider(provider) : provider;
  if (isSystemProvider(resolvedProvider)) {
    if (!speechModule || typeof speechModule.getAvailableVoicesAsync !== 'function') return [];
    try {
      const voices = await speechModule.getAvailableVoicesAsync();
      return Array.isArray(voices) ? voices : [];
    } catch (error) {
      return [];
    }
  }
  return Array.isArray(resolvedProvider && resolvedProvider.voices) ? resolvedProvider.voices : [];
}
