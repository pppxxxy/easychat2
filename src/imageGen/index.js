import { getImageProvider } from './providers';
import { registerSecretValues } from '../secrets';

const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_RETRIES = 1;

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
  if (status === 401 || status === 403) return '密钥无效或未授权';
  if (status === 429) return '请求过于频繁，请稍后重试';
  return `生成失败（HTTP ${status}）`;
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

export async function listModels({ provider, config }) {
  const resolvedProvider = typeof provider === 'string' ? getImageProvider(provider) : provider;
  const resolvedConfig = normalizeConfig(resolvedProvider, config);
  const url = listUrlFor(resolvedProvider, resolvedConfig.baseUrl);
  if (!url) {
    throw new Error(resolvedProvider.listModelsPath === ''
      ? '该服务不提供模型列表接口'
      : '请先填写 API 地址');
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
  });
  return parseModelList(data);
}

export async function detectImageProvider({ provider, config, model }) {
  try {
    const models = await listModels({ provider, config });
    const normalizedModel = String(model || '').trim();
    if (normalizedModel && models.length > 0) {
      const hit = models.some(item => item === normalizedModel || item.includes(normalizedModel));
      return {
        ok: true,
        mode: 'list',
        models,
        modelFound: hit,
        message: hit ? '已连通，且模型在列表中' : '已连通，但列表中未找到该模型名',
      };
    }
    return { ok: true, mode: 'list', models, message: '已连通' };
  } catch (listError) {
    const listMessage = (listError && listError.message) || '列表接口不可用';
    if (/密钥无效|未授权/.test(listMessage)) {
      return { ok: false, error: listMessage, authFailed: true };
    }
    // 不再自动试生成：生图按次计费，是否花这笔钱必须由用户决定，
    // 这里只告诉调用方“需要试生成才能判定”，由 UI 询问后再调 probeImageProvider。
    return { ok: false, error: listMessage, needsProbe: true };
  }
}

export async function probeImageProvider({ provider, config, model, prompt }) {
  const resolvedProvider = typeof provider === 'string' ? getImageProvider(provider) : provider;
  if (!resolvedProvider) throw new Error('未知的生图服务');
  const result = await generateImage({
    provider: resolvedProvider,
    config,
    prompt: String(prompt || '').trim() || 'a small red dot',
    model,
    // 探测用最小尺寸，压低试生成费用
    size: resolvedProvider.probeSize || '512x512',
  });
  return { images: Array.isArray(result.images) ? result.images.length : 0 };
}

function xhrRequest({ method, url, headers, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        xhr.abort();
      } catch (error) {}
      reject(new Error('生成超时，请稍后重试'));
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
      let parsed = null;
      try {
        parsed = JSON.parse(xhr.responseText || '{}');
      } catch (error) {
        finish(reject, new Error('生成返回无法解析'));
        return;
      }
      finish(resolve, parsed);
    };
    xhr.onerror = () => finish(reject, new Error('生成网络请求失败'));
    xhr.onabort = () => finish(reject, new Error('生成已中断'));
    try {
      xhr.send(body || null);
    } catch (error) {
      finish(reject, error);
    }
  });
}

export async function generateImage({ provider, prompt, imageFile, imageUrl, imageUri, image, model, size, seed, extra, config, imageMime }) {
  const resolvedProvider = typeof provider === 'string' ? getImageProvider(provider) : provider;
  if (!resolvedProvider) throw new Error('未知的生图服务');
  const resolvedConfig = config || extra && extra.config || {};
  const normalized = normalizeConfig(resolvedProvider, resolvedConfig);
  // 登记密钥：生图报错文本可能带出裸 Key，脱敏时按真实值兜住
  registerSecretValues([normalized.apiKey]);
  if (!normalized.baseUrl) throw new Error('请先填写 API 地址');
  if (!normalized.apiKey && resolvedProvider.auth && resolvedProvider.auth.type) {
    throw new Error('请先填写 API 密钥');
  }
  const text = String(prompt || '').trim();
  const hasImage = Boolean(imageFile || imageUrl || imageUri || image);
  if (!text && !hasImage) throw new Error('请输入提示词');
  if (hasImage) {
    if (!resolvedProvider.i2i) throw new Error('该服务不支持图生图');
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
  if (!request) throw new Error('请求配置不完整');

  const retries = Number.isInteger(resolvedProvider.retries) ? resolvedProvider.retries : DEFAULT_RETRIES;
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const data = await xhrRequest({
        ...request,
        timeoutMs: resolvedProvider.timeoutMs || DEFAULT_TIMEOUT_MS,
      });
      const images = parseImages(resolvedProvider, data);
      if (images.length === 0) throw new Error('未从响应中解析到图片');
      return { images, raw: data };
    } catch (error) {
      lastError = error;
      // 生图接口按次计费：超时或网络中断时服务端可能已经受理并计费，
      // 重试会造成重复扣费，所以这类失败一律不再重试（只重试确定未受理的失败）。
      if (error && /密钥无效|过于频繁|请先填写|提示词|无法解析|未从响应|超时|网络|中断/.test(error.message || '')) throw error;
    }
  }
  throw lastError || new Error('生成失败');
}
