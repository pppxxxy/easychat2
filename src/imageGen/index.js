import { getImageProvider } from './providers.js';
import { registerSecretValues } from '../storage/secrets.js';
import vendorXhr from '../network/vendorHttp.js';
import {
  buildLocalDreamBody,
  completeEventToImage,
  createLocalDreamSseParser,
  describeLocalDreamNetworkError,
  localDreamEndpoint,
  LOCAL_DREAM_GENERATE_PATH,
  LOCAL_DREAM_TOKENIZE_PATH,
} from './localDream.js';
import { tActive } from '../i18n/index.js';

const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_RETRIES = 0;

export function getByPath(source, path) {
  if (path === undefined || path === null || path === '') return undefined;
  return String(path).split('.').reduce((current, key) => {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) return current[Number(key)];
    return current[key];
  }, source);
}

function setByPath(target, path, value) {
  if (!path) return;
  const keys = String(path).split('.');
  let node = target;
  for (let index = 0; index < keys.length - 1; index += 1) {
    const key = keys[index];
    if (Array.isArray(node)) {
      const arrayKey = Number(key);
      if (node[arrayKey] === undefined || node[arrayKey] === null) node[arrayKey] = {};
      node = node[arrayKey];
    } else {
      if (node[key] === undefined || node[key] === null || typeof node[key] !== 'object') {
        node[key] = {};
      }
      node = node[key];
    }
  }
  const last = keys[keys.length - 1];
  if (Array.isArray(node)) {
    node[Number(last)] = value;
  } else {
    node[last] = value;
  }
}

function deepClone(value) {
  if (Array.isArray(value)) return value.map(deepClone);
  if (value && typeof value === 'object') {
    const result = {};
    Object.entries(value).forEach(([key, item]) => {
      result[key] = deepClone(item);
    });
    return result;
  }
  return value;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function substitute(value, placeholders) {
  if (Array.isArray(value)) return value.map(item => substitute(item, placeholders));
  if (isPlainObject(value)) {
    const result = {};
    Object.entries(value).forEach(([key, item]) => {
      result[key] = substitute(item, placeholders);
    });
    return result;
  }
  if (typeof value === 'string') {
    const exact = value.match(/^\{([a-zA-Z0-9_]+)\}$/);
    if (exact) {
      const replacement = placeholders[exact[1]];
      return replacement === undefined ? '' : replacement;
    }
    return value.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key) => {
      const replacement = placeholders[key];
      return replacement === undefined ? match : String(replacement);
    });
  }
  return value;
}

export function normalizeConfig(provider, config) {
  const source = config && typeof config === 'object' ? config : {};
  const baseUrl = provider.custom
    ? String(source.baseUrl || '').trim()
    : String(source.baseUrl || provider.baseUrl || '').trim();
  return {
    baseUrl,
    apiKey: String(source.apiKey || '').trim(),
    model: String(source.model || provider.defaultModel || '').trim().replace(/^models\//, ''),
    extra: isPlainObject(source.extra) ? source.extra : {},
  };
}

export function buildRequest({ provider, config, prompt, image, imageUri, model, size, seed, extra, imageMime }) {
  const resolved = normalizeConfig(provider, config);
  if (!resolved.baseUrl) return null;
  const useI2I = Boolean(image || imageUri);
  const spec = useI2I ? provider.i2i : provider.t2i;
  if (!spec || !spec.template) return null;

  const rawImage = image || '';
  const imagePlaceholder = (useI2I && spec.stripImagePrefix)
    ? String(rawImage).replace(/^data:[^;]*;base64,/, '')
    : rawImage;
  const rawModel = model || resolved.model || '';
  const cleanModel = String(rawModel).replace(/^models\//, '');
  const placeholders = {
    prompt: prompt === undefined ? '' : prompt,
    model: cleanModel,
    image: imagePlaceholder,
    size: size || '',
    seed: seed === undefined || seed === null ? '' : seed,
    mime: imageMime || 'image/png',
  };
  const payload = substitute(deepClone(spec.template), placeholders);
  const params = provider.params || {};
  const mapping = [
    ['size', size],
    ['steps', extra && extra.steps],
    ['guidance', extra && extra.guidance],
    ['seed', seed],
  ];
  mapping.forEach(([key, value]) => {
    const field = params[key];
    if (field && value !== undefined && value !== null && value !== '') {
      const normalizedValue = key === 'size' ? String(value).replace('*', 'x') : value;
      setByPath(payload, field, normalizedValue);
    }
  });
  if (provider.sizeSplit && typeof size === 'string' && size.includes('*')) {
    const [rawWidth, rawHeight] = size.split('*');
    const width = Number(rawWidth);
    const height = Number(rawHeight);
    if (Number.isFinite(width) && width > 0) setByPath(payload, provider.sizeSplit.width, Math.round(width));
    if (Number.isFinite(height) && height > 0) setByPath(payload, provider.sizeSplit.height, Math.round(height));
  }
  if (extra && extra.negativePrompt && provider.negativePromptField) {
    setByPath(payload, provider.negativePromptField, extra.negativePrompt);
  }
  if (resolved.extra && isPlainObject(resolved.extra)) {
    Object.entries(resolved.extra).forEach(([key, value]) => {
      setByPath(payload, key, value);
    });
  }
  if (extra && isPlainObject(extra.params)) {
    Object.entries(extra.params).forEach(([key, value]) => {
      setByPath(payload, key, value);
    });
  }
  if (provider.modelField && resolved.model) {
    setByPath(payload, provider.modelField, resolved.model);
  }
  const headers = { ...(provider.headers || {}) };
  let url = substitute(resolved.baseUrl, placeholders);
  // 某些平台的 t2i 与 i2i 使用不同端点：spec.endpoint 直接指定完整 URL，
  // spec.endpointFromBaseUrl 则把 baseUrl 中的某段路径替换掉（如 /images/generations → /images/edits）。
  if (spec.endpoint) {
    url = substitute(spec.endpoint, placeholders);
  } else if (spec.endpointFromBaseUrl) {
    const { from, to } = spec.endpointFromBaseUrl;
    if (from && to && url.includes(from)) url = url.replace(from, to);
  }
  const auth = provider.auth || {};
  if (auth.type === 'query') {
    const join = url.includes('?') ? '&' : '?';
    url = `${url}${join}${encodeURIComponent(auth.keyName)}=${encodeURIComponent(resolved.apiKey)}`;
  } else if (auth.type === 'body') {
    setByPath(payload, auth.keyName, resolved.apiKey);
  } else if (auth.keyName) {
    headers[auth.keyName] = `${auth.prefix || ''}${resolved.apiKey}`;
  }

  const method = provider.method || 'POST';
  const requestFormat = spec.requestFormat || provider.requestFormat;
  const useMultipart = requestFormat === 'multipart' && typeof FormData !== 'undefined';
  if (useMultipart) {
    const form = new FormData();
    const imageAttachment = useI2I && imageUri && typeof imageUri === 'string' && /^(file|content|ph|assets-library|blob):/i.test(imageUri);
    Object.entries(payload).forEach(([key, value]) => {
      if (value === undefined || value === null || value === '') return;
      if (key === 'image' && imageAttachment) {
        form.append(key, {
          uri: imageUri,
          name: `image.${(String(imageMime || 'image/png').split('/')[1] || 'png')}`,
          type: imageMime || 'image/png',
        });
        return;
      }
      if (isPlainObject(value) || Array.isArray(value)) {
        form.append(key, JSON.stringify(value));
      } else {
        form.append(key, String(value));
      }
    });
    const multipartHeaders = { ...headers };
    delete multipartHeaders['Content-Type'];
    return { method, url, headers: multipartHeaders, body: form };
  }

  if (method === 'GET') {
    const queryString = Object.entries(payload)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(typeof value === 'string' ? value : JSON.stringify(value))}`)
      .join('&');
    const join = url.includes('?') ? '&' : '?';
    return { method: 'GET', url: queryString ? `${url}${join}${queryString}` : url, headers, body: null };
  }

  headers['Content-Type'] = headers['Content-Type'] || 'application/json';
  return { method: 'POST', url, headers, body: JSON.stringify(payload) };
}

export function parseImages(provider, data) {
  const response = provider.response || {};
  const root = response.path ? getByPath(data, response.path) : data;
  const list = Array.isArray(root) ? root : root === undefined || root === null ? [] : [root];
  const images = [];
  list.forEach(item => {
    if (item === undefined || item === null) return;
    if (typeof item === 'string') {
      if (/^https?:\/\//i.test(item) || /^data:image\//i.test(item)) images.push({ url: item });
      else images.push({ base64: item });
      return;
    }
    const url = response.urlField ? getByPath(item, response.urlField) : undefined;
    const base64 = response.base64Field ? getByPath(item, response.base64Field) : undefined;
    if (url) {
      images.push({ url: String(url) });
    } else if (base64) {
      images.push({ base64: String(base64) });
    }
  });
  return images;
}

export function mapHttpError(status) {
  if (status === 401 || status === 403) return tActive('error.imageGen.httpAuth');
  if (status === 429) return tActive('error.imageGen.httpRateLimited');
  return tActive('error.imageGen.httpFailed', { status });
}

function originOf(url) {
  const match = String(url || '').match(/^(https?:\/\/[^/]+)/i);
  return match ? match[1] : '';
}

function stripKnownSuffix(url, suffixes) {
  const list = Array.isArray(suffixes) ? suffixes : [];
  for (let index = 0; index < list.length; index += 1) {
    const suffix = list[index];
    if (suffix && url.endsWith(suffix)) return url.slice(0, -suffix.length);
  }
  return url;
}

function listUrlFor(provider, baseUrl) {
  const trimmed = String(baseUrl || '').replace(/\/+$/, '');
  if (!trimmed) return '';
  const path = provider.listModelsPath !== undefined ? provider.listModelsPath : '/v1/models';
  if (!path) return '';
  if (provider.custom) {
    const directory = stripKnownSuffix(trimmed, provider.baseUrlSuffixes);
    return `${directory}${path}`;
  }
  const origin = originOf(trimmed);
  return origin ? `${origin}${path}` : '';
}

export function parseModelList(data) {
  if (!data) return [];
  if (Array.isArray(data)) {
    return data
      .map(item => (typeof item === 'string' ? item : (item && (item.id || item.name))))
      .map(item => String(item || '').trim())
      .filter(Boolean);
  }
  if (Array.isArray(data.data)) return parseModelList(data.data);
  if (Array.isArray(data.models)) return parseModelList(data.models);
  return [];
}

export async function listModels({ provider, config, signal }) {
  const resolvedProvider = typeof provider === 'string' ? getImageProvider(provider) : provider;
  const resolvedConfig = normalizeConfig(resolvedProvider, config);
  const url = listUrlFor(resolvedProvider, resolvedConfig.baseUrl);
  if (!url) {
    throw new Error(resolvedProvider.listModelsPath === ''
      ? tActive('error.imageGen.noModelList')
      : tActive('error.imageGen.baseUrlRequired'));
  }
  const headers = { ...(resolvedProvider.headers || {}) };
  const auth = resolvedProvider.auth || {};
  if (auth.keyName) headers[auth.keyName] = `${auth.prefix || ''}${resolvedConfig.apiKey}`;
  const data = await xhrRequest({
    method: 'GET',
    url,
    headers,
    body: null,
     timeoutMs: Math.min(resolvedProvider.timeoutMs || DEFAULT_TIMEOUT_MS, 30000),
     signal,
   });

  return parseModelList(data);
}

export async function detectImageProvider({ provider, config, model, signal }) {
  const resolvedProvider = typeof provider === 'string' ? getImageProvider(provider) : provider;
  // Local Dream 无模型列表接口：用 /tokenize 探活（能返回 token 计数即在监听）。
  if (resolvedProvider && resolvedProvider.localDream) {
    try {
      const normalized = normalizeConfig(resolvedProvider, config || {});
      const url = localDreamEndpoint(normalized.baseUrl, LOCAL_DREAM_TOKENIZE_PATH);
      const data = await xhrRequest({
        method: 'POST',
        url,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'connectivity check' }),
        timeoutMs: 15000,
        signal,
      });
      const count = Number(data && data.count);
      const max = Number(data && data.max_length) || 77;
      return {
        ok: true,
        mode: 'probe',
        models: [],
        message: Number.isFinite(count) ? tActive('imageGen.detect.connectedLocalClip', { max }) : tActive('imageGen.detect.connected'),
      };
    } catch (error) {
      if (error && error.name === 'AbortError') throw error;
      return { ok: false, error: describeLocalDreamNetworkError(error) };
    }
  }
  try {
    const models = await listModels({ provider, config, signal });
    const normalizedModel = String(model || '').trim();
    if (normalizedModel && models.length > 0) {
      const hit = models.some(item => item === normalizedModel || item.includes(normalizedModel));
      return {
        ok: true,
        mode: 'list',
        models,
        modelFound: hit,
        message: hit ? tActive('imageGen.detect.connectedModelFound') : tActive('imageGen.detect.connectedModelMissing'),
      };
    }
    return { ok: true, mode: 'list', models, message: tActive('imageGen.detect.connected') };
  } catch (listError) {
    if (listError && listError.name === 'AbortError') throw listError;
    const listMessage = (listError && listError.message) || tActive('error.imageGen.listUnavailable');
    // 文案已 i18n：判定鉴权失败优先看 HTTP 状态码，正则仅兜底旧链路文本。
    if ((listError && (listError.status === 401 || listError.status === 403))
      || /密钥无效|未授权|Invalid key|unauthorized/i.test(listMessage)) {
      return { ok: false, error: listMessage, authFailed: true };
    }
    // 不再自动试生成：生图按次计费，是否花这笔钱必须由用户决定，
    // 这里只告诉调用方“需要试生成才能判定”，由 UI 询问后再调 probeImageProvider。
    return { ok: false, error: listMessage, needsProbe: true };
  }
}

export async function probeImageProvider({ provider, config, model, prompt, signal }) {
  const resolvedProvider = typeof provider === 'string' ? getImageProvider(provider) : provider;
  if (!resolvedProvider) throw new Error(tActive('error.imageGen.unknownProvider'));
  const result = await generateImage({
    provider: resolvedProvider,
    config,
    prompt: String(prompt || '').trim() || 'a small red dot',
    model,
    // 探测用最小尺寸，压低试生成费用
     size: resolvedProvider.probeSize || '512x512',
     signal,
   });

  return { images: Array.isArray(result.images) ? result.images.length : 0 };
}

function createAbortError() {
  const error = new Error(tActive('error.imageGen.aborted'));
  error.name = 'AbortError';
  error.canceled = true;
  return error;
}

function createHttpError(status) {
  const error = new Error(mapHttpError(status));
  error.status = status;
  error.retryable = status === 429;
  return error;
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function xhrRequest({ method, url, headers, body, timeoutMs, signal }) {
  return vendorXhr({
    method: method || 'POST',
    url,
    headers,
    body,
    signal,
    timeoutMs,
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
    abortFlagOnSignal: true,
    timeoutAbortOrder: 'finishThenAbort',
    onTimeoutError: () => new Error(tActive('error.imageGen.timeout')),
    onAbortError: () => createAbortError(),
    onAbortEventError: canceled => (canceled ? createAbortError() : new Error(tActive('error.imageGen.aborted'))),
    onNetworkError: () => new Error(tActive('error.imageGen.networkFailed')),
    onHttpError: status => createHttpError(status),
    parse: xhr => JSON.parse(xhr.responseText || '{}'),
    onParseError: () => new Error(tActive('error.imageGen.parseFailed')),
  });
}

export async function generateImage({ provider, prompt, imageFile, imageUrl, imageUri, image, model, size, seed, extra, config, imageMime, signal, onProgress }) {
  const resolvedProvider = typeof provider === 'string' ? getImageProvider(provider) : provider;
  if (!resolvedProvider) throw new Error(tActive('error.imageGen.unknownProvider'));
  const resolvedConfig = config || extra && extra.config || {};
  const normalized = normalizeConfig(resolvedProvider, resolvedConfig);
  // 登记密钥：生图报错文本可能带出裸 Key，脱敏时按真实值兜住
  registerSecretValues([normalized.apiKey]);
  if (!normalized.baseUrl) throw new Error(tActive('error.imageGen.baseUrlRequired'));
  if (!normalized.apiKey && resolvedProvider.auth && resolvedProvider.auth.type) {
    throw new Error(tActive('error.imageGen.apiKeyRequired'));
  }
  const text = String(prompt || '').trim();
  const hasImage = Boolean(imageFile || imageUrl || imageUri || image);
  if (!text && !hasImage) throw new Error(tActive('error.imageGen.promptRequired'));
  if (hasImage) {
    if (!resolvedProvider.i2i) throw new Error(tActive('error.imageGen.i2iUnsupported'));
  }
  // Local Dream 端侧生图：走专用 SSE 分支（裸 RGB → PNG），不走声明式模板。
  if (resolvedProvider.localDream) {
    return generateLocalDreamImage({
      provider: resolvedProvider,
      config: resolvedConfig,
      prompt: text,
      image,
      imageFile,
      imageUri,
      size,
      seed,
      extra,
      signal,
      onProgress,
    });
  }
  const imageValue = image || imageFile || imageUrl || imageUri || '';
  const request = buildRequest({
    provider: resolvedProvider,
    config: resolvedConfig,
    prompt: text,
    image: hasImage ? imageValue : '',
    imageUri: hasImage ? imageUri : '',
    model,
    size,
    seed,
    extra,
    imageMime,
  });
  if (!request) throw new Error(tActive('error.imageGen.requestIncomplete'));

  const configuredRetries = Number.isInteger(resolvedProvider.retries)
    ? resolvedProvider.retries
    : DEFAULT_RETRIES;
  const retries = resolvedProvider.allowAutomaticRetries === true
    ? Math.max(0, configuredRetries)
    : 0;
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const data = await xhrRequest({
        ...request,
        timeoutMs: resolvedProvider.timeoutMs || DEFAULT_TIMEOUT_MS,
        signal,
      });
      const images = parseImages(resolvedProvider, data);
      if (images.length === 0) throw new Error(tActive('error.imageGen.noImagesParsed'));
      return { images, raw: data };
    } catch (error) {
      lastError = error;
      if (attempt >= retries || !error || error.retryable !== true) throw error;
      await wait(Math.min(2000, 250 * (attempt + 1)));
    }
  }
  throw lastError || new Error(tActive('error.imageGen.failed'));
}

// Local Dream 专用：POST /generate，SSE 流式。RN 的 fetch 无流式 body，沿用内置
// XMLHttpRequest 的 onprogress + 累积 responseText（与 src/api.js 同一做法）。
function generateLocalDreamImage({ provider, config, prompt, image, imageFile, imageUri, size, seed, extra, signal, onProgress }) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(createAbortError());
      return;
    }
    const normalized = normalizeConfig(provider, config);
    const sourceImage = String(image || imageFile || imageUri || '').replace(/^data:[^;]*;base64,/, '');
    const body = buildLocalDreamBody({
      prompt,
      negativePrompt: extra && extra.negativePrompt,
      steps: extra && extra.steps,
      cfg: extra && (extra.cfg !== undefined ? extra.cfg : extra.guidance),
      seed,
      size,
      image: sourceImage || undefined,
      mask: extra && extra.mask,
      denoiseStrength: extra && extra.denoiseStrength,
      scheduler: extra && extra.scheduler,
      aspectRatio: extra && extra.aspectRatio,
    });
    const url = localDreamEndpoint(normalized.baseUrl, LOCAL_DREAM_GENERATE_PATH);
    const xhr = new XMLHttpRequest();
    let settled = false;
    let canceled = false;
    let completeImage = null;
    let streamError = null;
    let removeAbortListener = null;

    const cleanup = () => {
      if (removeAbortListener) {
        removeAbortListener();
        removeAbortListener = null;
      }
    };
    const finishReject = error => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const finishResolve = value => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const parser = createLocalDreamSseParser(event => {
      if (event.type === 'progress') {
        if (typeof onProgress === 'function' && event.percent !== null) onProgress(event.percent);
        return;
      }
      if (event.type === 'complete') {
        try {
          completeImage = completeEventToImage(event);
        } catch (error) {
          streamError = error;
        }
        return;
      }
      if (event.type === 'error') {
        streamError = new Error(event.message || tActive('error.imageGen.localFailed'));
      }
    });

    const onAbort = () => {
      canceled = true;
      try {
        xhr.abort();
      } catch (error) {}
      finishReject(createAbortError());
    };
    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener('abort', onAbort);
    }

    xhr.open('POST', url);
    try {
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.setRequestHeader('Accept', 'text/event-stream');
    } catch (error) {}
    xhr.onprogress = () => {
      if (settled) return;
      try {
        parser.push(xhr.responseText || '');
      } catch (error) {
        streamError = error;
      }
    };
    xhr.onload = () => {
      if (settled) return;
      parser.push(xhr.responseText || '');
      parser.flush();
      if (xhr.status < 200 || xhr.status >= 300) {
        // 客户端错误（无效 JSON、缺 prompt 等）后端可能返回非 SSE 的 JSON 体。
        let detail = '';
        try {
          detail = JSON.parse(xhr.responseText || '{}')?.error?.message
            || JSON.parse(xhr.responseText || '{}')?.message
            || '';
        } catch (error) {}
        finishReject(new Error(detail || mapHttpError(xhr.status)));
        return;
      }
      if (streamError) {
        finishReject(streamError);
        return;
      }
      if (!completeImage) {
        finishReject(new Error(tActive('error.imageGen.localNoResult')));
        return;
      }
      finishResolve({ images: [{ ...completeImage }], raw: completeImage });
    };
    xhr.onerror = () => {
      if (settled) return;
      finishReject(new Error(describeLocalDreamNetworkError('Network request failed')));
    };
    xhr.onabort = () => {
      if (settled) return;
      finishReject(canceled ? createAbortError() : new Error(tActive('error.imageGen.aborted')));
    };
    try {
      xhr.send(JSON.stringify(body));
    } catch (error) {
      finishReject(error);
    }
  });
}
