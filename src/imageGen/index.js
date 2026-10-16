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
// FEAT-AC13 P0-1：HTTP 错误体细节提取（与 SSE 路径共用的唯一实现）。
import { composeHttpErrorMessage, describeHttpErrorBody } from './httpError.js';
// FEAT-AC13 P1-3/P1-4：端点写法自检 + gpt-image 参数兼容（纯函数）。
import { ENDPOINT_ISSUES, inspectImageEndpoint, skipsResponseFormat, withoutResponseFormat } from './endpointCheck.js';
import { isReservedPathKey as isReservedPathKeyShared } from '../utils/reservedPathKeys.js';
import { splitUrlQuery } from '../utils/urlQuery.js';

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

// 保留键清单是**单一来源**：零依赖叶子模块 utils/reservedPathKeys.js
//（此前 imageGen / tts / chat/toolNoticeVisibility 各手写一份，漏同步一处就留一条旁路）。
// 这里刻意保留同名的薄包装而不是直接 import 使用：tests/imageGen.test.mjs 的
// **阳性对照**用例靠正则把本函数体换成 `return false` 来还原「修复前」实现，证明
// 上面的哨兵断言真的能发现泄漏（改名/改形会让那条对照立刻报错，而不是退化成空转）。
// 换名重构时请同步那条对照的判据，不要让对照静默失效。
function isReservedPathKey(key) {
  return isReservedPathKeyShared(key);
}

// 为什么必须**逐层**拦：写进来的路径来自设置页「额外参数(JSON)」这类用户可编辑输入，
// 危险键可以藏在任意一层（`a.__proto__.x` 的首层 `a` 完全合法），只在首层查会整类漏掉。
function setByPath(target, path, value) {
  if (!path) return;
  const keys = String(path).split('.');
  let node = target;
  for (let index = 0; index < keys.length - 1; index += 1) {
    const key = keys[index];
    // 命中即整键丢弃（return），**不要**改用 Object.defineProperty 去「保住」它：
    // 那只是把危险键塞成 own 属性，后续展开/序列化时又会写进新对象。
    if (isReservedPathKey(key)) return;
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
  if (isReservedPathKey(last)) return;
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
  let payload = substitute(deepClone(spec.template), placeholders);
  // FEAT-AC13 P1-4：gpt-image-1 系模型不接受 `response_format`，传了报
  // `400 Unknown parameter`。openai-relay 的模板里硬编码了 `response_format: 'b64_json'`，
  // 于是这类模型**文生图与改图全中**。按模型名跳过注入（把模板带来的那个键摘掉）。
  //
  // 为什么在这里按模型名判、而不是在 provider 表里加开关：模型名是**用户填的运行时值**
  //（设置页可改），provider 表是静态声明——判据必须跟着实际要发的模型走。
  //
  // ⚠️ 只摘**顶层** response_format（见 endpointCheck.js）：OpenAI 图像接口就是顶层参数；
  // 深层同名字段不属于本规则范围，动了就越权。
  //
  // ⚠️ 只摘**模板带来**的那一个：用户若在「额外参数(JSON)」里显式写了 response_format，
  // 那是他的明确选择，下面 extra 那几步照旧会写回去——**不替用户做决定**。
  //
  // ⚠️ 核实更正：任务书称 `extraDefaults`（providers.js L214）也注入该参数——
  // 实测**不成立**：`extraDefaults` 在全仓没有任何消费点，是死数据。故此处只处理模板。
  const effectiveModel = model || resolved.model || '';
  if (skipsResponseFormat(effectiveModel)) payload = withoutResponseFormat(payload);
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
    // 后缀剥离只看「路径」部分（先例：src/vectorMemory/providers.js:41-48）。整串 endsWith
    // 时，带 query 的地址（.../images/generations?api-version=…）必然不中，于是
    // /images/generations 没被剥掉、listModelsPath 被追加进 query 值 → 404。
    // 同函数内两种口径此前不一致：非 custom 分支经 originOf（:269-272）天然切掉 query，
    // custom 分支不切。这里把 custom 也对齐为「只认路径」，两分支口径一致。
    const { path: directory } = splitUrlQuery(trimmed);
    return `${stripKnownSuffix(directory, provider.baseUrlSuffixes)}${path}`;
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

function createHttpError(status, xhr) {
  // FEAT-AC13 P0-1：带上上游响应体细节（此前整个丢弃，用户只看到「生成失败（HTTP 400）」）。
  // 状态码文案在前、上游 message 在后（composeHttpErrorMessage 的契约）。
  const message = composeHttpErrorMessage(mapHttpError(status), xhr && xhr.responseText);
  const error = new Error(message);
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
    onHttpError: (status, xhr) => createHttpError(status, xhr),
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
  // FEAT-AC13 P1-3：**端点写法自检**（只对声明了 baseUrlSuffixes 的 provider，即
  // openai-relay 这类「地址必须落在具体端点上」的自定义服务）。
  //
  // 为什么必须本地拦：它的 endpointFromBaseUrl 只在 baseUrl 含 `/images/generations`
  // 时才换 `/images/edits`。用户填 `/v1`、`/images/edits` 或裸域名时，请求会打到
  // 错的地方——而设置页的「检测」探的是 `/models`，**检测通过不代表生成端点对**。
  // 错误本来要等一次真生成才以远端 404 暴露；现在提前到本地，并给出正确形状。
  //
  // 边界：只查**声明了 baseUrlSuffixes 的 provider**。别家 provider（gitee/agnes 等）
  // 的 baseUrl 本来就是完整端点，对它们做同样的检查会误报——不在本轮范围。
  //
  // ⚠️ 位置在 hasImage 之后：EDITS_ONLY 分支要按「有没有参考图」分流（改图场景下
  // `/images/edits` 是对的，不该拦），所以必须先知道 hasImage。
  if (Array.isArray(resolvedProvider.baseUrlSuffixes) && resolvedProvider.baseUrlSuffixes.length > 0) {
    const issue = inspectImageEndpoint(normalized.baseUrl);
    if (issue === ENDPOINT_ISSUES.MISSING_IMAGES_PATH) {
      throw new Error(tActive('error.imageGen.endpointMissingImagesPath', {
        placeholder: resolvedProvider.baseUrlPlaceholder || 'https://…/v1/images/generations',
      }));
    }
    if (issue === ENDPOINT_ISSUES.EDITS_ONLY && !hasImage) {
      // 改图能用，但文生图会打到 edits 端点——如实告知，不假装没问题。
      throw new Error(tActive('error.imageGen.endpointEditsOnly', {
        placeholder: resolvedProvider.baseUrlPlaceholder || 'https://…/v1/images/generations',
      }));
    }
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
  // FEAT-AC13 P2-5：**契约防御**——i2i 场景只给了 imageUrl（https 地址）时 fail-fast。
  //
  // 为什么必败：multipart 附件通道只认 imageUri 的
  // `file|content|ph|assets-library|blob:` 前缀（见 buildRequest 里的 imageAttachment），
  // https URL 不在白名单里，于是它会退化成**一个 multipart 字符串字段**——
  // 上游收到的是 `image="https://…"` 而不是文件，必然失败（且报错很难懂）。
  //
  // 当前无调用方（休眠契约缺陷）：ImageGenScreen 传的是 imageFile + imageUri，
  // ChatScreen 走纯文生图。但契约留着就是个坑——将来谁按签名传 imageUrl 就会踩。
  // 在这里明确拒绝，好过让它悄悄退化。
  //
  // 边界：**不改** multipart 附件白名单本身（任务书明确不许动）；只是在此之前 fail-fast。
  if (hasImage && !imageFile && !imageUri && !image && imageUrl) {
    throw new Error(tActive('error.imageGen.imageUrlUnsupported'));
  }
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
  // FEAT-AC13 P2-6：**每次尝试重建请求体**。
  //
  // 为什么必须重建：multipart 场景下 buildRequest 返回的 body 是 **FormData 实例**，
  // 而 FormData 是「一次性」的——同一个实例重复 send 在 RN 上行为不确定
  //（部分实现会把已消费的 part 丢掉，重试实际发的是残缺体）。重试循环复用同一对象
  // 等于把「重试」变成「发坏请求」。
  //
  // 当前 `allowAutomaticRetries` 未开（retries 恒为 0，循环只跑一次），所以这条
  // 缺陷**尚未暴露**——但一旦有人打开开关就会踩。与其留个「打开就坏」的开关，
  // 不如现在把循环改成每次重建（对 retries=0 的现状零行为变化）。
  //
  // 为什么把构建放进闭包而不是循环体里直接调：JSON 路径下重建结果逐字相同
  //（无副作用），multipart 路径下每次拿到**新的** FormData——两条路都正确。
  const buildFreshRequest = () => buildRequest({
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
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      // 首次用上面已构建好的（早失败一次，别等到这里才发现配置不完整）；
      // 重试才重建——这样 retries=0 时与旧行为逐字一致。
      const attemptRequest = attempt === 0 ? request : buildFreshRequest();
      if (!attemptRequest) throw new Error(tActive('error.imageGen.requestIncomplete'));
      const data = await xhrRequest({
        ...attemptRequest,
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
        // FEAT-AC13 P0-1：提取逻辑**收口到共用纯函数**（此前是这里内联的一份，
        // 主传输路径没有——两条路径各写一份必然漂移）。语义不变：
        // 取到细节就用细节，取不到才回落到按状态码的文案。
        const detail = describeHttpErrorBody(xhr.responseText);
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
