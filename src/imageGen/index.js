import { getImageProvider } from './providers';

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
    model: String(source.model || '').trim(),
    extra: isPlainObject(source.extra) ? source.extra : {},
  };
}

export function buildRequest({ provider, config, prompt, image, model, size, seed, extra }) {
  const resolved = normalizeConfig(provider, config);
  if (!resolved.baseUrl) return null;
  const useI2I = Boolean(image);
  const spec = useI2I ? provider.i2i : provider.t2i;
  if (!spec || !spec.template) return null;

  const placeholders = {
    prompt: prompt === undefined ? '' : prompt,
    model: model || resolved.model || '',
    image: image || '',
    size: size || '',
    seed: seed === undefined || seed === null ? '' : seed,
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
      setByPath(payload, field, value);
    }
  });
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

  const headers = {};
  let url = resolved.baseUrl;
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
  if (useI2I && spec.mode === 'multipart' && typeof FormData !== 'undefined') {
    const form = new FormData();
    Object.entries(payload).forEach(([key, value]) => {
      if (value === undefined || value === null || value === '') return;
      if (isPlainObject(value) || Array.isArray(value)) {
        form.append(key, JSON.stringify(value));
      } else {
        form.append(key, String(value));
      }
    });
    return { method, url, headers, body: form };
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

export async function generateImage({ provider, prompt, imageFile, imageUrl, image, model, size, seed, extra, config }) {
  const resolvedProvider = typeof provider === 'string' ? getImageProvider(provider) : provider;
  if (!resolvedProvider) throw new Error('未知的生图服务');
  const resolvedConfig = config || extra && extra.config || {};
  const normalized = normalizeConfig(resolvedProvider, resolvedConfig);
  if (!normalized.baseUrl) throw new Error('请先填写 API 地址');
  if (!normalized.apiKey && resolvedProvider.auth && resolvedProvider.auth.type) {
    throw new Error('请先填写 API 密钥');
  }
  const text = String(prompt || '').trim();
  const hasImage = Boolean(imageFile || imageUrl || image);
  if (!text && !hasImage) throw new Error('请输入提示词');
  if (imageFile || imageUrl) {
    if (!resolvedProvider.i2i) throw new Error('该服务不支持图生图');
  }
  const imageValue = image || imageFile || imageUrl || '';
  const request = buildRequest({
    provider: resolvedProvider,
    config: resolvedConfig,
    prompt: text,
    image: hasImage ? imageValue : '',
    model,
    size,
    seed,
    extra,
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
      if (error && /密钥无效|过于频繁|请先填写|提示词|无法解析|未从响应/.test(error.message || '')) throw error;
    }
  }
  throw lastError || new Error('生成失败');
}
