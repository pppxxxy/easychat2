// TTS 引擎声明表（唯一事实源）。
//
// i18n 约定（本文件是「provider/字段 → 词条 key」的**唯一**来源）：
// 声明表里的 label / placeholder / unsupportedNote 是**中文常量**，只能当兜底用；
// 界面一律按 labelKey / placeholderKey / noteKey 查词条（见文件末的取值函数）。
// 为什么 key 放在这里而不是各面板各写一份：曾经 CharacterOverridesSection.js 自己
// 维护了一份 `TTS_PROVIDER_NAME_KEYS`，而 TtsPanel.js 直接渲染 label —— 同族一处做对
// 一处没做，英文界面下「播报源」就漏出中文引擎名与中文占位符。而 eslint 的
// no-hardcoded-chinese 只查 Alert/JSX/模块级常量，看不见数据文件里的 label
//（实测 `eslint src/tts/providers.js src/TtsPanel.js` exit=0），所以这条违规规则抓不到。
//
// 为什么不直接拼 `tts.providerName.${id}`：provider id 里有连字符
//（xiaomi-mimo / iflytek-spark / tencent-cloud），而词条 key 只允许字母数字段
//（tests/i18n.test.mjs 的格式不变量）。新增 provider / 字段时在这里补一行
// labelKey（placeholderKey / noteKey 按需）+ 两个语言的词条。
export const TTS_MAX_CHARS = 800;

export const TTS_PROVIDERS = [
  {
    id: 'system',
    labelKey: 'tts.providerName.system',
    engine: 'system',
    fields: [
      { key: 'voice', labelKey: 'tts.field.voice', optional: true, placeholderKey: 'tts.ph.voiceDefault' },
      { key: 'speed', labelKey: 'tts.field.speed', optional: true, placeholder: '0.5 - 2.0' },
    ],
    voices: [],
    timeoutMs: 0,
    retries: 0,
  },
  {
    id: 'xiaomi-mimo',
    labelKey: 'tts.providerName.xiaomiMimo',
    apiKeyUrl: 'https://platform.xiaomimimo.com',
    // 官方仅有 /v1/chat/completions 端点（实测 GET 返回 405 = 路由存在）；
    // /v1/audio/speech 不存在（实测 404）。TTS 走 chat 形态：合成文本作为
    // assistant 消息，音频 base64 返回在 choices[0].message.audio.data。
    baseUrl: 'https://api.xiaomimimo.com/v1/chat/completions',
    method: 'POST',
    requestMode: 'chat',
    // MiMo 鉴权用 api-key 请求头（官方也支持 Authorization: Bearer）。
    auth: { type: 'header', keyName: 'api-key' },
    // 官方 audio.format 默认 wav；播放端按 mp3 解会坏音频/无声，显式请求 mp3。
    payloadDefaults: { audio: { format: 'mp3' } },
    responseMime: 'audio/mp3',
    response: { mode: 'base64', path: 'choices.0.message.audio.data' },
    // 预设音色走 audio.voice（chat 形态的音频参数）；留空则由模型用默认音色。
    voiceField: 'audio.voice',
    fields: [
      { key: 'baseUrl', labelKey: 'tts.field.baseUrl', placeholder: 'https://api.xiaomimimo.com/v1/chat/completions' },
      { key: 'apiKey', labelKey: 'tts.field.apiKey', secret: true, placeholderKey: 'tts.ph.xiaomiKey' },
      // 模型 ID 是 OpenAI 协议的小写名；大写是产品名不是模型名，写错会 404/报错。
      { key: 'model', labelKey: 'tts.field.model', placeholder: 'mimo-v2.5-tts' },
      { key: 'voice', labelKey: 'tts.field.voice', optional: true, placeholder: 'mimo_default' },
    ],
    // 官方预置音色；留空（默认项）由模型自选。voicedesign/voiceclone 另有专门模型。
    voices: ['mimo_default', 'default_zh', 'default_en', 'Mia', 'Chloe', 'Milo', 'Dean'],
    timeoutMs: 30000,
    retries: 1,
    custom: true,
  },
  {
    id: 'siliconflow',
    labelKey: 'tts.providerName.siliconflow',
    apiKeyUrl: 'https://cloud.siliconflow.cn/account/ak',
    baseUrl: 'https://api.siliconflow.cn/v1/audio/speech',
    method: 'POST',
    auth: { type: 'header', keyName: 'Authorization', prefix: 'Bearer ' },
    textField: 'input',
    voiceField: 'voice',
    speedField: 'speed',
    formatField: 'response_format',
    response: { mode: 'binary' },
    fields: [
      { key: 'baseUrl', labelKey: 'tts.field.baseUrl', placeholder: 'https://api.siliconflow.cn/v1/audio/speech' },
      { key: 'apiKey', labelKey: 'tts.field.apiKey', secret: true, placeholder: 'sk-...' },
      { key: 'model', labelKey: 'tts.field.model', placeholder: 'FunAudioLLM/CosyVoice2-0.5B' },
      { key: 'voice', labelKey: 'tts.field.voice', optional: true, placeholder: 'FunAudioLLM/CosyVoice2-0.5B:alex' },
      { key: 'speed', labelKey: 'tts.field.speed', optional: true, placeholder: '1.0' },
    ],
    voices: ['FunAudioLLM/CosyVoice2-0.5B:alex', 'FunAudioLLM/CosyVoice2-0.5B:anna'],
    timeoutMs: 30000,
    retries: 1,
    custom: true,
  },
  {
    id: 'iflytek-spark',
    labelKey: 'tts.providerName.iflytekSpark',
    apiKeyUrl: 'https://console.xfyun.cn/services/bmx1',
    baseUrl: 'wss://tts-api.xfyun.cn/v2/tts',
    method: 'POST',
    auth: { type: 'header', keyName: 'Authorization' },
    signer: 'iflytek',
    textField: 'text',
    voiceField: 'vcn',
    speedField: 'speed',
    formatField: 'aue',
    response: { mode: 'base64', path: 'data.audio' },
    fields: [
      { key: 'appId', labelKey: 'tts.field.appId', placeholderKey: 'tts.ph.appId' },
      { key: 'apiKey', labelKey: 'tts.field.apiKeyCompact', secret: true, placeholder: 'API Key' },
      { key: 'appSecretKey', labelKey: 'tts.field.apiSecret', secret: true, placeholder: 'API Secret' },
      { key: 'voice', labelKey: 'tts.field.voice', optional: true, placeholder: 'xiaoyan' },
      { key: 'speed', labelKey: 'tts.field.speed', optional: true, placeholder: '50' },
    ],
    timeoutMs: 30000,
    retries: 0,
    unsupported: true,
    unsupportedNoteKey: 'tts.unsupported.iflytek',
  },
  {
    id: 'stepfun',
    labelKey: 'tts.providerName.stepfun',
    apiKeyUrl: 'https://platform.stepfun.com',
    baseUrl: 'https://api.stepfun.com/v1/audio/speech',
    method: 'POST',
    auth: { type: 'header', keyName: 'Authorization', prefix: 'Bearer ' },
    textField: 'input',
    voiceField: 'voice',
    speedField: 'speed',
    formatField: 'response_format',
    response: { mode: 'binary' },
    fields: [
      { key: 'baseUrl', labelKey: 'tts.field.baseUrl', placeholder: 'https://api.stepfun.com/v1/audio/speech' },
      { key: 'apiKey', labelKey: 'tts.field.apiKey', secret: true, placeholder: 'sk-...' },
      { key: 'model', labelKey: 'tts.field.model', placeholder: 'stepaudio-3-tts' },
      { key: 'voice', labelKey: 'tts.field.voice', optional: true, placeholderKey: 'tts.ph.officialVoiceList' },
      { key: 'speed', labelKey: 'tts.field.speed', optional: true, placeholder: '1.0' },
    ],
    voices: ['cixingnansheng', 'zhaixiaowai'],
    timeoutMs: 30000,
    retries: 1,
    custom: true,
  },
  {
    id: 'tencent-cloud',
    labelKey: 'tts.providerName.tencentCloud',
    apiKeyUrl: 'https://console.cloud.tencent.com/cam/capi',
    baseUrl: 'https://tts.tencentcloudapi.com',
    method: 'POST',
    auth: { type: 'header', keyName: 'Authorization' },
    signer: 'tencent',
    textField: 'Text',
    voiceField: 'VoiceType',
    speedField: 'Speed',
    formatField: 'Codec',
    response: { mode: 'base64', path: 'Response.Audio' },
    fields: [
      { key: 'appId', labelKey: 'tts.field.secretId', placeholder: 'SecretId' },
      { key: 'apiKey', labelKey: 'tts.field.secretKey', secret: true, placeholder: 'SecretKey' },
      { key: 'region', labelKey: 'tts.field.region', optional: true, placeholder: 'ap-guangzhou' },
      { key: 'voice', labelKey: 'tts.field.voiceId', optional: true, placeholder: '101001' },
      { key: 'speed', labelKey: 'tts.field.speed', optional: true, placeholder: '0' },
    ],
    timeoutMs: 30000,
    retries: 1,
    custom: true,
    unsupported: true,
    unsupportedNoteKey: 'tts.unsupported.tencent',
  },
  {
    id: 'aliyun',
    // 端点是智能语音交互 NLS 网关（不是百炼 DashScope）：
    // 令牌必须来自智能语音交互控制台，百炼密钥打不通这个端点。
    labelKey: 'tts.providerName.aliyun',
    apiKeyUrl: 'https://nls-portal.console.aliyun.com/',
    baseUrl: 'https://nls-gateway-cn-shanghai.aliyuncs.com/stream/v1/tts',
    method: 'POST',
    // 官方确认的凭据写法：token 走查询参数（或 JSON 请求体内 header.token）；
    // X-NLS-Token 头形式未在官方文档命中，不采用。
    auth: {},
    queryFields: [
      { name: 'appkey', from: 'appId' },
      { name: 'token', from: 'apiKey' },
    ],
    textField: 'text',
    voiceField: 'voice',
    speedField: 'speech_rate',
    formatField: 'format',
    // 官方默认 format=pcm 会与播放端 mp3 假设冲突，显式取 mp3。
    payloadDefaults: { format: 'mp3' },
    response: { mode: 'binary' },
    fields: [
      { key: 'apiKey', labelKey: 'tts.field.accessToken', secret: true, placeholderKey: 'tts.ph.aliyunKey' },
      { key: 'appId', labelKey: 'tts.field.appKey', placeholderKey: 'tts.ph.appKey' },
      { key: 'voice', labelKey: 'tts.field.voice', optional: true, placeholder: 'xiaoyun' },
      { key: 'speed', labelKey: 'tts.field.speed', optional: true, placeholder: '0' },
    ],
    timeoutMs: 30000,
    retries: 1,
    custom: true,
  },
  {
    id: 'baidu',
    labelKey: 'tts.providerName.baidu',
    apiKeyUrl: 'https://console.bce.baidu.com/ai-engine/old/#/ai/speech/app/list',
    baseUrl: 'https://tsn.baidu.com/text2audio',
    method: 'POST',
    // 百度短文本合成要求表单提交，令牌参数名是 tok（不是 access_token），
    // ctp=1 / lan=zh 为官方必填。
    requestFormat: 'form',
    // 官方 SDK 把令牌写进表单体 data['tok'] 并从查询串删除：tokenInBody 对齐此行为。
    auth: { type: 'token', keyName: 'tok', tokenInBody: true, tokenUrl: 'https://aip.baidubce.com/oauth/2.0/token', tokenFields: { grant_type: 'client_credentials' }, tokenPath: 'access_token', tokenTtlSec: 2592000 },
    payloadDefaults: { ctp: 1, lan: 'zh', cuid: 'easychat2', aue: 3 },
    textField: 'tex',
    voiceField: 'per',
    speedField: 'spd',
    formatField: 'aue',
    response: { mode: 'binary' },
    // 官方短文本上限约 60 汉字（默认 800 会被服务端拒绝）。
    maxChars: 60,
    fields: [
      { key: 'apiKey', labelKey: 'tts.field.apiKey', secret: true, placeholder: 'API Key' },
      { key: 'appSecretKey', labelKey: 'tts.field.secretKeyEn', secret: true, placeholder: 'Secret Key' },
      { key: 'voice', labelKey: 'tts.field.speaker', optional: true, placeholder: '0' },
      { key: 'speed', labelKey: 'tts.field.speed', optional: true, placeholder: '5' },
    ],
    timeoutMs: 30000,
    retries: 1,
    custom: true,
  },
  {
    id: 'volcano',
    labelKey: 'tts.providerName.volcano',
    apiKeyUrl: 'https://console.volcengine.com/speech/new/setting/apikeys',
    baseUrl: 'https://openspeech.bytedance.com/api/v1/tts',
    method: 'POST',
    auth: { type: 'header', keyName: 'Authorization', prefix: 'Bearer;' },
    signer: 'volcano',
    // 火山官方载荷嵌套：request.text / audio.voice_type / audio.speed_ratio / audio.encoding，
    // app.cluster、user.uid、request.reqid、request.operation 由引擎 signer 分支补齐。
    textField: 'request.text',
    voiceField: 'audio.voice_type',
    speedField: 'audio.speed_ratio',
    formatField: 'audio.encoding',
    // 官方默认 encoding=pcm 会与播放端 mp3 假设冲突，显式取 mp3。
    payloadDefaults: { audio: { encoding: 'mp3' } },
    response: { mode: 'base64', path: 'data' },
    fields: [
      { key: 'appId', labelKey: 'tts.field.appId', placeholderKey: 'tts.ph.appId' },
      { key: 'apiKey', labelKey: 'tts.field.accessTokenEn', secret: true, placeholderKey: 'tts.ph.accessToken' },
      { key: 'voice', labelKey: 'tts.field.voice', optional: true, placeholder: 'BV001_streaming' },
      { key: 'speed', labelKey: 'tts.field.speed', optional: true, placeholder: '1.0' },
    ],
    timeoutMs: 30000,
    retries: 1,
    custom: true,
  },
  {
    id: 'minimax',
    labelKey: 'tts.providerName.minimax',
    apiKeyUrl: 'https://platform.minimaxi.com/',
    // 官方现行域名：国际 api.minimax.io / 国内 api.minimaxi.com；旧的 api.minimax.chat 已弃用。
    baseUrl: 'https://api.minimaxi.com/v1/t2a_v2',
    method: 'POST',
    // MiniMax 同时需要两种凭据：GroupId 进查询串，API Key 进 Bearer 头。
    auth: { type: 'query', keyName: 'GroupId', bearer: true },
    textField: 'text',
    voiceField: 'voice_setting.voice_id',
    speedField: 'voice_setting.speed',
    formatField: 'audio_setting.format',
    // 官方默认 output_format=hex：data.audio 是 hex 编码，按 base64 解会得到坏音频。
    response: { mode: 'hex', path: 'data.audio' },
    fields: [
      { key: 'baseUrl', labelKey: 'tts.field.baseUrl', optional: true, placeholderKey: 'tts.ph.minimaxBaseUrl' },
      { key: 'apiKey', labelKey: 'tts.field.apiKey', secret: true, placeholder: 'Bearer Token' },
      { key: 'appId', labelKey: 'tts.field.groupId', placeholder: 'GroupId' },
      { key: 'model', labelKey: 'tts.field.model', placeholder: 'speech-2.8-hd' },
      { key: 'voice', labelKey: 'tts.field.voice', optional: true, placeholderKey: 'tts.ph.officialVoiceList' },
      { key: 'speed', labelKey: 'tts.field.speed', optional: true, placeholder: '1.0' },
    ],
    timeoutMs: 30000,
    retries: 1,
    custom: true,
  },
];

export function getTtsProvider(id) {
  return TTS_PROVIDERS.find(provider => provider.id === id) || TTS_PROVIDERS[0];
}

// ---- 显示名 / 字段文案的 i18n 取值（两个面板共用的唯一入口）----
//
// 取值形态照 CharacterOverridesSection 的既有做法（同 PluginPanel.js:260,263 的
// labelKey 先例）：**key 优先 + 常量兜底**，不发明第三种形态。兜底分两层：
//   ① 词条缺失时 t(key) 会原样返回 key（见 i18n/index.js 的 translate 回退链），
//      此时回落常量文案——界面不会出现 `tts.field.label.voice` 这种原始键名；
//   ② 新增 provider/字段时忘了补 labelKey，同样回落常量文案，不显示空白。
// 零依赖：t 由调用方注入，本模块不 import i18n，避免与 i18n 层形成环
//（guard-structure.mjs 会检出模块循环依赖）。
function pick(t, key, fallback) {
  if (!key) return String(fallback == null ? '' : fallback);
  const translated = t(key);
  return translated === key ? String(fallback == null ? '' : fallback) : translated;
}

// 引擎显示名。查不到词条才回落到声明表里的中文常量（英文界面下即为漏译信号）。
export function ttsProviderLabel(t, provider) {
  const item = provider || {};
  return pick(t, item.labelKey, item.label || item.id || '');
}

// 字段标题。同上：labelKey 优先，中文常量兜底。
export function ttsFieldLabel(t, field) {
  const item = field || {};
  return pick(t, item.labelKey, item.label);
}

// 字段占位符。**只有含中文文案的占位符才需要 placeholderKey**——URL / 模型 ID /
// 数字这类语言无关的字面量保持原样（给 'sk-...' 也造一条词条只会稀释词条表）。
// 但「中文占位符忘了配 placeholderKey」正是本批要防的复发形态，测试里有反向断言。
export function ttsFieldPlaceholder(t, field) {
  const item = field || {};
  return pick(t, item.placeholderKey, item.placeholder);
}

// 「暂不支持」的原因说明（unsupportedNote 同样是中文常量，会被渲染进提示）。
export function ttsUnsupportedNote(t, provider) {
  const item = provider || {};
  return pick(t, item.noteKey, item.unsupportedNote);
}
