// 角色运行期配置的**唯一解析层**（聊天 API / OCR 模型 API / TTS API+音声 / 语音转文字 API）。
//
// 为什么必须只有这一处：这个仓库已经被「改了定义方、漏了调用方」咬了五次以上
// （findOrphanToolMessages 零调用、matchBeforeToolHooks 零调用、longHorizon.js 整模块
// 死、capabilities.js 手抄清单漏同步、workflowRunner 漏传参数）。角色专属配置最容易
// 重演这一幕——四处各自写 `override ?? global`，下次加第五类时必然只改一处。
// 所以：**解析只在这里发生一次**，四类消费点全部调本模块，不许自己读盘自己判。
//
// 解析规则（四类一致，逐条都有行为测试）：
// 1. 角色有覆盖且覆盖指向的配置**仍然存在** → 用覆盖；
// 2. 角色没有覆盖 → 用全局（getApiConfigs 的 activeId / OCR 设置 / TTS activeProvider /
//    转写 activeId）；
// 3. 角色有覆盖但指向的配置**已被删除** → **回落全局**，并把 `missing=true` 与
//    `missingId` 报给界面。选「回落全局」而不是「报错」的理由：删除一条 API 配置是
//    全局动作，不该把某个角色的对话直接打断成不可用——用户要的是「还能聊」，同时
//    在角色编辑页**看见**「这条专属配置失效了」（界面必须显式提示，不许静默空白）。
//    「报错」还会把一次配置清理变成 N 个角色各自的硬故障，用户只能逐个角色去修。
//
// 密钥：本模块不新增任何密钥字段，返回的 config 里带的 apiKey 是既有保险箱 hydrate
// 出来的内存值（与今天 useChatTts / transcription 拿到的完全同一份），不落盘、不导出。
//
// 生效时机：四类消费点都在**每次使用时**调本模块（不是启动时读一次缓存住），所以
// 角色编辑页改完立即生效；测试见 tests/characterRuntimeConfig.test.mjs。

import { getApiConfigs, getActiveModel } from '../storage/apiConfigs.js';
import { getCharacterOverrides } from '../storage/characterOverrides.js';
import { normalizeImageRecognitionSettings, getImageRecognitionSettings } from '../storage/settings/imageRecognition.js';
import { getTranscriptionSettings, getTtsSettings } from '../storage/settings/tts.js';
import { resolveTranscription } from '../transcription.js';
import { TTS_PROVIDERS, getTtsProvider } from '../tts/providers.js';

// TTS provider 是否真实存在。**不能**用 getTtsProvider(id) 判：它对未知 id 会回落到
// TTS_PROVIDERS[0]（system），于是「指向已删 provider」会被静默当成「系统引擎」——
// 那正是本模块要显式报告的情况。
export function hasTtsProvider(providerId) {
  const id = String(providerId || '');
  return TTS_PROVIDERS.some(item => item.id === id);
}

function findConfig(configs, id) {
  const wanted = String(id || '');
  if (!wanted) return null;
  return (Array.isArray(configs) ? configs : []).find(item => String(item.id) === wanted) || null;
}

// 一组「角色覆盖 → 生效目标」的公共判定：存在则用覆盖，不存在则回落全局并标记 missing。
function pickOverride({ overrideId, globalValue, lookup }) {
  const wanted = String(overrideId || '');
  if (!wanted) return { overridden: false, missing: false, missingId: '', target: globalValue };
  const found = lookup(wanted);
  if (!found) return { overridden: true, missing: true, missingId: wanted, target: globalValue };
  return { overridden: true, missing: false, missingId: '', target: found };
}

// 全量解析。返回四类各自的「生效值 + 是否被单独配过 + 覆盖是否已失效」。
export async function resolveCharacterRuntimeConfig(characterId) {
  const id = String(characterId || '');
  const [overrides, apiState, ocrGlobalRaw, ttsGlobalRaw, transcriptionGlobalRaw] = await Promise.all([
    getCharacterOverrides(id).catch(() => null),
    getApiConfigs().catch(() => ({ configs: [], activeId: '' })),
    getImageRecognitionSettings().catch(() => null),
    getTtsSettings().catch(() => null),
    getTranscriptionSettings().catch(() => null),
  ]);
  const o = overrides || {};
  const configs = Array.isArray(apiState && apiState.configs) ? apiState.configs : [];

  // ---- 1. 聊天 API（可带专属模型）----
  const globalChat = findConfig(configs, apiState && apiState.activeId) || configs[0] || null;
  const chatPick = pickOverride({
    overrideId: o.chatApiConfigId,
    globalValue: globalChat,
    lookup: wanted => findConfig(configs, wanted),
  });
  const chatConfig = chatPick.target;
  // 专属模型只在专属配置**确实生效**时使用；回落全局时连模型一起回落，避免出现
  // 「全局配置 A 配了模型 A 的模型名」这种串味。
  const chatModel = chatPick.overridden && !chatPick.missing && o.chatModel
    ? o.chatModel
    : (chatConfig ? getActiveModel(chatConfig) : '');
  const chatApplied = chatPick.overridden && !chatPick.missing && !!chatConfig;
  // 传给 sendChatMessage / runAgentTurn 的覆盖片段：**只有专属配置生效时才带键**。
  // 无覆盖时返回 {}，保持既有「按全局激活项解析」的行为与错误类型不变。
  const chatRequestOptions = chatApplied
    ? { configId: String(chatConfig.id || ''), model: chatModel }
    : {};
  // 生效配置表：只有「专属模型 ≠ 该配置自带的 activeModel」时才复制一份替换，
  // 其余情况原样返回（无覆盖时与 getApiConfigs() 逐字段相同 → 零行为变化）。
  const effectiveChatConfig = chatConfig && getActiveModel(chatConfig) !== chatModel
    ? { ...chatConfig, activeModel: chatModel }
    : chatConfig;
  const effectiveConfigs = effectiveChatConfig === chatConfig
    ? configs
    : configs.map(item => (String(item.id) === String(chatConfig.id) ? effectiveChatConfig : item));

  // ---- 2. OCR 模型 API（可带专属模型名）----
  const ocrGlobal = normalizeImageRecognitionSettings(ocrGlobalRaw);
  const ocrPick = pickOverride({
    overrideId: o.ocrApiConfigId,
    globalValue: null,
    lookup: wanted => findConfig(configs, wanted),
  });
  const ocrApplied = ocrPick.overridden && !ocrPick.missing;
  // 生效的 OCR 设置：形状与全局完全一致（引擎的 settingsOverride 参数直接吃它），
  // 只换 apiConfigId / model 两项。**enabled 仍取全局**：总开关属于「这个功能开不开」，
  // 不属于「用哪条配置」，专属配置不该绕过用户关掉的开关。
  const ocrSettings = ocrApplied
    ? {
      ...ocrGlobal,
      apiConfigId: String(ocrPick.target.id || ''),
      model: o.ocrModel || getActiveModel(ocrPick.target),
    }
    : ocrGlobal;

  // ---- 3. TTS API + 音声 ----
  const ttsGlobal = ttsGlobalRaw || { autoBroadcast: false, activeProvider: 'system', providers: {} };
  const globalProviderId = String(ttsGlobal.activeProvider || 'system');
  const ttsPick = pickOverride({
    overrideId: o.ttsProviderId,
    globalValue: globalProviderId,
    lookup: wanted => (hasTtsProvider(wanted) ? wanted : null),
  });
  const ttsProviderId = ttsPick.target || globalProviderId;
  const provider = getTtsProvider(ttsProviderId);
  const providerConfig = (ttsGlobal.providers && ttsGlobal.providers[ttsProviderId]) || {};
  // 音声（voice）在既有存储里是 provider 配置的一个字段，不是独立设置。专属音声因此
  // 表达为「在生效 provider 的配置上换掉 voice」——不新增密钥、不新增存储位置。
  // 空字符串 = 跟随该 provider 的全局音色（不写空值，免得把用户填过的音色抹掉）。
  // 只改音色不改 provider 也算配过这一项（ttsVoice 非空即生效）。
  const ttsVoiceOverridden = !!o.ttsVoice;
  // provider 覆盖失效时连音色一起丢弃：音色 id 是**某个 provider 的**音色，
  // 把它套到回落后的 provider 上只会得到「音色不存在」的报错。
  const ttsVoice = ttsVoiceOverridden && !ttsPick.missing
    ? o.ttsVoice
    : String(providerConfig.voice || '');
  const ttsConfig = ttsVoice ? { ...providerConfig, voice: ttsVoice } : { ...providerConfig };

  // ---- 4. 语音转文字 API ----
  const transcriptionGlobal = transcriptionGlobalRaw || { activeId: '', configs: [] };
  const transcriptionConfigs = Array.isArray(transcriptionGlobal.configs) ? transcriptionGlobal.configs : [];
  const globalDedicated = findConfig(transcriptionConfigs, transcriptionGlobal.activeId);
  const transcriptionPick = pickOverride({
    overrideId: o.transcriptionConfigId,
    globalValue: globalDedicated,
    lookup: wanted => findConfig(transcriptionConfigs, wanted),
  });

  return {
    characterId: id,
    overrides: o,
    chat: {
      configId: chatConfig ? String(chatConfig.id || '') : '',
      config: effectiveChatConfig,
      configs: effectiveConfigs,
      activeId: effectiveChatConfig ? String(effectiveChatConfig.id || '') : '',
      model: chatModel,
      overridden: chatPick.overridden,
      missing: chatPick.missing,
      missingId: chatPick.missingId,
      requestOptions: chatRequestOptions,
    },
    ocr: {
      settings: ocrSettings,
      config: ocrApplied ? ocrPick.target : null,
      model: String(ocrSettings.model || ''),
      overridden: ocrPick.overridden,
      missing: ocrPick.missing,
      missingId: ocrPick.missingId,
    },
    tts: {
      providerId: String(provider.id || ''),
      provider,
      config: ttsConfig,
      voice: ttsVoice,
      overridden: ttsPick.overridden || ttsVoiceOverridden,
      missing: ttsPick.missing,
      missingId: ttsPick.missingId,
    },
    transcription: {
      configId: transcriptionPick.target ? String(transcriptionPick.target.id || '') : '',
      config: transcriptionPick.target || null,
      overridden: transcriptionPick.overridden,
      missing: transcriptionPick.missing,
      missingId: transcriptionPick.missingId,
    },
  };
}

// ---- 四类消费点用的薄适配（都只调上面那一个解析层）----

// 聊天 API：与 storage/apiConfigs 的 getApiConfigs() **同形**（{configs, activeId}），
// 差别只有两点——activeId 已按角色专属覆盖解析；当角色指定了专属模型时，返回数组里
// 那一条的 activeModel 已换成专属模型。于是消费点里既有的
// `getActiveModel(current)` / `capabilitiesForModel(current, ...)` /
// `getConfigFingerprint(current)` **全部自动按专属口径**，不需要各自再判一次覆盖。
// 第三个字段 chatRequestOptions 只在专属配置生效时非空，直接展开进请求选项即可。
export async function getCharacterApiConfigs(characterId) {
  const runtime = await resolveCharacterRuntimeConfig(characterId);
  return {
    configs: runtime.chat.configs,
    activeId: runtime.chat.activeId,
    chatRequestOptions: runtime.chat.requestOptions,
  };
}

// OCR：生效的图片识别设置（引擎的 settingsOverride 入参）。
export async function resolveCharacterOcrSettings(characterId) {
  const runtime = await resolveCharacterRuntimeConfig(characterId);
  return runtime.ocr.settings;
}

// TTS + 音声：生效的 provider 与其配置（ttsSpeak / synthesize 的入参）。
export async function resolveCharacterTtsSpeak(characterId) {
  const runtime = await resolveCharacterRuntimeConfig(characterId);
  return { provider: runtime.tts.provider, config: runtime.tts.config, providerId: runtime.tts.providerId };
}

// 语音转文字：resolveTranscription 的入参（chatConfig + dedicated）。
// 注意 chatConfig 用的是**角色专属聊天 API**：转写的「复用当前聊天来源」这一档
// 因此也跟着角色走，不会出现「聊天走 A 配置、转写偷偷走全局 B 配置」。
export async function resolveCharacterTranscriptionSources(characterId) {
  const runtime = await resolveCharacterRuntimeConfig(characterId);
  return { chatConfig: runtime.chat.config, dedicated: runtime.transcription.config };
}

// 转写消费点的**单一入口**（聊天页与工作区共用）：解析层 + resolveTranscription 的组合。
// 消费点只调这一个函数，不自己拼 { chatConfig, dedicated }——否则「谁负责补哪一半」
// 又会变成各写一份。
export async function resolveCharacterTranscription(characterId) {
  return resolveTranscription(await resolveCharacterTranscriptionSources(characterId));
}
