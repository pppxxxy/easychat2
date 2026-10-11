// 图片识别（OCR）引擎：把图片交给「图片识别模型」换成文字描述，带缓存、限并发与
// 明确的失败降级。
//
// 为什么单独一层：聊天路径（useChatSend）与看屏幕路径（useScreenWatchComments）都要
// 「先识别、再喂主模型」，两者的差别只在「拿到描述之后怎么用」。把识别本身收成一处，
// 缓存/并发/超时/降级只有一份实现。
//
// 密钥：本模块不碰密钥。请求走 network/api.js 的 configId + model 覆盖，密钥仍由
// apiConfigs 的保险箱在请求解析时提供。
//
// 三条不可省的纪律（都有行为测试钉住）：
// 1. **失败不许静默丢图**：识别失败时由 decideImageRecognitionAction 给出可处置的
//    结论（主模型支持识图 → 退回直发原图；不支持 → 交给调用方给用户可见的失败提示）；
// 2. **缓存按内容 hash**：同一张图不重复识别；键含配置/模型/提示词，改了就不复用旧结果；
// 3. **限并发**：多张图不能一次打爆接口（默认 2，可配 1-4）。

import { getConfigFingerprint, sendChatMessage } from '../network/api.js';
import { getApiConfigs, capabilitiesForModel, getActiveModel } from '../storage/apiConfigs.js';
import { getLocalModelMediaCapabilities } from '../localModel/modelState.js';
import { getActiveLocalModel, getLocalModelSettings } from '../storage/localModels.js';
import { readImageDataUri } from '../chat/attachments.js';
import {
  buildImageDescriptionText,
  imageDescriptionFailed,
  imageDescriptionPrefix,
} from '../chat/imageDescriptionPrompt.js';
import { sha256Ascii, bytesToBase64Url } from '../mcp/sha256.js';
import {
  getImageRecognitionSettings,
  imageRecognitionCacheKey,
  readImageRecognitionCache,
  writeImageRecognitionCache,
} from '../storage/settings/imageRecognition.js';

// 识别结果里两段固定文本（发给主模型的提示词，不进 i18n）由
// chat/imageDescriptionPrompt.js 单点定义，这里复用并对外 re-export，
// 让「引擎的调用方」与「上下文投影」用同一份文本。
export { buildImageDescriptionText, imageDescriptionFailed, imageDescriptionPrefix };

// ---- 纯函数 ----

// 限并发映射：结果顺序与输入一致（顺序错位会让描述配错图）。
export async function mapWithConcurrency(items, limit, worker) {
  const list = Array.isArray(items) ? items : [];
  const size = Math.max(1, Math.floor(Number(limit)) || 1);
  const results = new Array(list.length);
  let cursor = 0;
  const runners = new Array(Math.min(size, list.length)).fill(null).map(async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= list.length) return;
      results[index] = await worker(list[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

// 图片内容 hash：对 data URI 的 base64 正文取 SHA-256。同一张图（同编码同 mime）
// 必然得到同一个 hash——这正是「同一张图不重复识别」的判据。
export function hashImageContent(dataUri) {
  const text = String(dataUri || '');
  const separator = text.indexOf(',');
  const body = separator >= 0 ? text.slice(separator + 1) : text;
  if (!body) return '';
  return bytesToBase64Url(sha256Ascii(body));
}

export function hashPrompt(prompt) {
  const text = String(prompt || '');
  if (!text) return '';
  return bytesToBase64Url(sha256Ascii(text));
}

// 「主模型能不能自己看图」：在线来源按**当前模型**解析 supportsVision，本地模型看多模态。
// 与 useScreenWatchComments.resolveScreenWatchCapabilities 同一口径（不要各判一套）。
export async function resolveMainModelVision() {
  const [apiConfig, localSettings, localItem] = await Promise.all([
    getApiConfigs().catch(() => ({ configs: [], activeId: '' })),
    getLocalModelSettings().catch(() => null),
    getActiveLocalModel().catch(() => null),
  ]);
  const configs = Array.isArray(apiConfig.configs) ? apiConfig.configs : [];
  const current = configs.find(item => item.id === apiConfig.activeId) || configs[0] || null;
  const caps = capabilitiesForModel(current, current ? getActiveModel(current) : '');
  return {
    vision: caps.supportsVision === true
      || !!getLocalModelMediaCapabilities(localSettings, localItem).vision,
    current,
  };
}

// 解析「图片识别」这次能不能用：开关、配置、模型名、密钥四项都要满足。
// 返回的 reason 用于界面分流（未启用 ≠ 配置不全 ≠ 没填密钥）。
export async function resolveImageRecognitionPlan(settingsOverride = null) {
  const settings = settingsOverride || await getImageRecognitionSettings();
  if (settings.enabled !== true) return { ready: false, reason: 'disabled', settings, config: null };
  const { configs } = await getApiConfigs().catch(() => ({ configs: [] }));
  const config = (Array.isArray(configs) ? configs : [])
    .find(item => String(item.id) === String(settings.apiConfigId)) || null;
  if (!config) return { ready: false, reason: 'no-config', settings, config: null };
  if (!String(settings.model || '').trim()) return { ready: false, reason: 'no-model', settings, config };
  if (!String(config.apiKey || '').trim()) return { ready: false, reason: 'no-key', settings, config };
  return { ready: true, reason: '', settings, config };
}

// 识别失败（或未启用）时该怎么办。**这是「不许静默丢图」的判定点**：
// - 主模型自己能看图 → 退回直发原图，用户仍然能看到这张图被处理；
// - 主模型看不到图 → 不能假装没事，交给调用方给用户可见的失败提示。
// 空图列表（没有图片）不属于失败，直接 continue。
export function decideImageRecognitionAction({ mainModelVision, failureCount = 0, imageCount = 0 } = {}) {
  const count = Math.max(0, Math.floor(Number(imageCount)) || 0);
  if (count === 0) return 'continue';
  const failures = Math.max(0, Math.floor(Number(failureCount)) || 0);
  if (failures === 0) return 'continue';
  return mainModelVision === true ? 'fallback-original' : 'fail';
}

// 识别成功时，要不要把**原图**也一起交给主模型。
// - 主模型看不到图 → 附了也没用（接口会拒/忽略），一律不附；
// - 看得到图 → 由用户配置 attachOriginal 决定（关掉时只发文字描述，更省流量）。
// 与失败降级分开成两个判定：失败时是「退回原图」，成功时是「要不要顺便附原图」，
// 两者的理由不同，混在一起会让提示文案说不清。
export function decideAttachOriginal({ settings, mainModelVision } = {}) {
  if (mainModelVision !== true) return false;
  return !!(settings && settings.attachOriginal === true);
}

// 把识别结果拼成给主模型的文本：实现已抽到 chat/imageDescriptionPrompt.js
// （与上下文投影共用同一份文本），这里直接 re-export，见文件上方 import。

// ---- 编排 ----

// 单张图识别。cacheEnabled=false 时跳过读缓存（仍写缓存）。
async function describeOne({
  dataUri,
  plan,
  deps,
  signal,
  cacheEnabled,
  timeoutSeconds,
}) {
  const send = deps.send;
  const readCache = deps.readCache;
  const writeCache = deps.writeCache;
  const cacheKey = imageRecognitionCacheKey({
    contentHash: hashImageContent(dataUri),
    configId: String(plan.config.id || ''),
    model: String(plan.settings.model || ''),
    promptHash: hashPrompt(plan.settings.descriptionPrompt),
  });
  if (cacheEnabled && cacheKey) {
    const cached = await readCache(cacheKey).catch(() => '');
    if (cached) return { description: cached, cached: true, cacheKey };
  }
  const messages = [{
    role: 'user',
    content: [
      { type: 'text', text: String(plan.settings.descriptionPrompt || '') },
      { type: 'image_url', image_url: { url: dataUri } },
    ],
  }];
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) throw Object.assign(new Error('aborted'), { code: 'ABORTED' });
    signal.addEventListener('abort', onOuterAbort, { once: true });
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    // 超时必须真的中止在途请求：只 race 掉 Promise 会让请求继续跑，
    // 用户改完配置重发时会与上一轮的结果交错。
    controller.abort();
  }, Math.max(1, Number(timeoutSeconds) || 1) * 1000);
  try {
    const text = await send(messages, {
      stream: false,
      signal: controller.signal,
      configId: String(plan.config.id || ''),
      model: String(plan.settings.model || ''),
      // 输出上限：走既有单次请求覆盖通道（不写回全局采样设置）。
      overrides: { maxTokens: plan.settings.maxOutputTokens },
      expectedConfigFingerprint: getConfigFingerprint(plan.config),
      expectedConfigId: String(plan.config.id || ''),
    });
    const description = String(text || '').trim();
    if (!description) throw Object.assign(new Error('empty-description'), { code: 'EMPTY' });
    if (cacheKey) await writeCache(cacheKey, description).catch(() => false);
    return { description, cached: false, cacheKey };
  } catch (error) {
    if (timedOut) {
      throw Object.assign(new Error('image-recognition-timeout'), { code: 'TIMEOUT' });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onOuterAbort);
  }
}

// 主入口：给一批图片（已读成 data URI）产出描述。
//
// 返回 { text, descriptions, failureCount, skipped, reason }：
// - text：可直接注入消息的文本（失败项也会如实标注）；
// - descriptions：逐条结果，供调用方决定「要不要继续附原图」；
// - failureCount：失败张数，交给 decideImageRecognitionAction 判定降级方向；
// - skipped：true 表示「没识别」（未启用/配置不全/空列表），此时 text 为空、failureCount 为 0。
export async function describeImages(dataUris, options = {}) {
  const list = (Array.isArray(dataUris) ? dataUris : []).map(item => String(item || '')).filter(Boolean);
  if (list.length === 0) {
    return { text: '', descriptions: [], failureCount: 0, skipped: true, reason: 'no-image', attachOriginal: false };
  }
  const deps = {
    send: typeof options.send === 'function' ? options.send : sendChatMessage,
    readCache: typeof options.readCache === 'function' ? options.readCache : readImageRecognitionCache,
    writeCache: typeof options.writeCache === 'function' ? options.writeCache : writeImageRecognitionCache,
  };
  const plan = await resolveImageRecognitionPlan(options.settings || null);
  if (!plan.ready) {
    return { text: '', descriptions: [], failureCount: 0, skipped: true, reason: plan.reason, attachOriginal: false };
  }
  // 调用方已经取消（切会话/重发）：不要发起识别，也不要把取消算成「识别失败」
  //（那会让降级判定以为图片坏了，进而给用户一条误导性的提示）。
  if (options.signal && options.signal.aborted) {
    return { text: '', descriptions: [], failureCount: 0, skipped: true, reason: 'aborted', attachOriginal: false };
  }
  const timeoutSeconds = options.timeoutSeconds || plan.settings.timeoutSeconds;
  const concurrency = options.concurrency || plan.settings.concurrency;
  const cacheEnabled = options.useCache !== false;
  const results = await mapWithConcurrency(list, concurrency, async dataUri => {
    try {
      const result = await describeOne({
        dataUri,
        plan,
        deps,
        signal: options.signal || null,
        cacheEnabled,
        timeoutSeconds,
      });
      return { dataUri, ...result };
    } catch (error) {
      return {
        dataUri,
        description: '',
        cached: false,
        cacheKey: '',
        error: String((error && error.code) || (error && error.message) || 'unknown'),
      };
    }
  });
  const failureCount = results.filter(item => !item.description).length;
  return {
    text: buildImageDescriptionText(results),
    descriptions: results,
    failureCount,
    skipped: false,
    reason: '',
    // 识别成功时要不要把原图也交给主模型（见 decideAttachOriginal）。
    attachOriginal: decideAttachOriginal({
      settings: plan.settings,
      mainModelVision: options.mainModelVision,
    }),
  };
}

// 便捷入口：读文件 → 识别 → 返回同一形状，但**结果按来源 URI 归属**
// （每条结果带 sourceUri）。调用方持有的是 file:// 路径，而识别需要 data URI，
// 两者对不上就无法把描述配回对应的消息——所以这里显式回填来源。
export async function describeImageFiles(uris, options = {}) {
  const list = (Array.isArray(uris) ? uris : []).map(item => String(item || '')).filter(Boolean);
  if (list.length === 0) {
    return { text: '', descriptions: [], failureCount: 0, skipped: true, reason: 'no-image', attachOriginal: false };
  }
  const readImage = typeof options.readImage === 'function' ? options.readImage : readImageDataUri;
  const pairs = [];
  for (const uri of list) {
    try {
      const dataUri = await readImage(uri);
      if (dataUri) pairs.push({ sourceUri: uri, dataUri: String(dataUri) });
    } catch (error) {
      // 单张读失败不拖垮整批：它会在下面被记为失败项（有可见后果，不是静默丢弃）。
      pairs.push({ sourceUri: uri, dataUri: '' });
    }
  }
  const usable = pairs.filter(pair => pair.dataUri);
  if (usable.length === 0) {
    return { text: '', descriptions: [], failureCount: 0, skipped: true, reason: 'read-failed', attachOriginal: false };
  }
  const described = await describeImages(usable.map(pair => pair.dataUri), options);
  const byDataUri = new Map();
  (described.descriptions || []).forEach(item => {
    if (item && item.dataUri) byDataUri.set(String(item.dataUri), item);
  });
  const descriptions = pairs.map(pair => {
    const found = pair.dataUri ? byDataUri.get(pair.dataUri) : null;
    if (found) return { ...found, sourceUri: pair.sourceUri };
    return {
      sourceUri: pair.sourceUri,
      dataUri: pair.dataUri,
      description: '',
      cached: false,
      cacheKey: '',
      error: pair.dataUri ? 'unknown' : 'read-failed',
    };
  });
  return {
    ...described,
    descriptions,
    // 读文件失败的也算识别失败（否则「一张图读不出来」会被当成识别成功而静默漏掉）。
    failureCount: descriptions.filter(item => !item.description).length,
  };
}
