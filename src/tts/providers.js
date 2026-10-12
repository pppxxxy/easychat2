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
    label: '系统引擎',
    labelKey: 'tts.providerName.system',
    engine: 'system',
    fields: [
      { key: 'voice', label: '音色', labelKey: 'tts.field.label.voice', optional: true, placeholder: '留空使用默认', placeholderKey: 'tts.field.placeholder.voiceDefault' },
      { key: 'speed', label: '语速', labelKey: 'tts.field.label.speed', optional: true, placeholder: '0.5 - 2.0' },
    ],
    voices: [],
    timeoutMs: 0,
    retries: 0,
  },
  {
    id: 'xiaomi-mimo',
    label: '小米 MiMo',
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
      { key: 'baseUrl', label: '接口地址', labelKey: 'tts.field.label.baseUrl', placeholder: 'https://api.xiaomimimo.com/v1/chat/completions' },
      { key: 'apiKey', label: 'API Key', labelKey: 'tts.field.label.apiKey', secret: true, placeholder: '在开放平台控制台获取', placeholderKey: 'tts.field.placeholder.mimoApiKey' },
      // 模型 ID 是 OpenAI 协议的小写名；大写是产品名不是模型名，写错会 404/报错。
      { key: 'model', label: '模型名', labelKey: 'tts.field.label.model', placeholder: 'mimo-v2.5-tts' },
      { key: 'voice', label: '音色', labelKey: 'tts.field.label.voice', optional: true, placeholder: 'mimo_default' },
    ],
    // 官方预置音色；留空（默认项）由模型自选。voicedesign/voiceclone 另有专门模型。
    voices: ['mimo_default', 'default_zh', 'default_en', 'Mia', 'Chloe', 'Milo', 'Dean'],
    timeoutMs: 30000,
    retries: 1,
    custom: true,
  },
  {
    id: 'siliconflow',
    label: '硅基流动',
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
      { key: 'baseUrl', label: '接口地址', labelKey: 'tts.field.label.baseUrl', placeholder: 'https://api.siliconflow.cn/v1/audio/speech' },
      { key: 'apiKey', label: 'API Key', labelKey: 'tts.field.label.apiKey', secret: true, placeholder: 'sk-...' },
      { key: 'model', label: '模型名', labelKey: 'tts.field.label.model', placeholder: 'FunAudioLLM/CosyVoice2-0.5B' },
      { key: 'voice', label: '音色', labelKey: 'tts.field.label.voice', optional: true, placeholder: 'FunAudioLLM/CosyVoice2-0.5B:alex' },
      { key: 'speed', label: '语速', labelKey: 'tts.field.label.speed', optional: true, placeholder: '1.0' },
    ],
    voices: ['FunAudioLLM/CosyVoice2-0.5B:alex', 'FunAudioLLM/CosyVoice2-0.5B:anna'],
    timeoutMs: 30000,
    retries: 1,
    custom: true,
  },
  {
    id: 'iflytek-spark',
    label: '讯飞星火',
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
      { key: 'appId', label: 'APPID', labelKey: 'tts.field.label.appId', placeholder: '应用 ID', placeholderKey: 'tts.field.placeholder.appId' },
      { key: 'apiKey', label: 'APIKey', labelKey: 'tts.field.label.iflytekApiKey', secret: true, placeholder: 'API Key' },
      { key: 'appSecretKey', label: 'APISecret', labelKey: 'tts.field.label.iflytekApiSecret', secret: true, placeholder: 'API Secret' },
      { key: 'voice', label: '音色', labelKey: 'tts.field.label.voice', optional: true, placeholder: 'xiaoyan' },
      { key: 'speed', label: '语速', labelKey: 'tts.field.label.speed', optional: true, placeholder: '50' },
    ],
    timeoutMs: 30000,
    retries: 0,
    unsupported: true,
    unsupportedNote: '讯飞语音走 WebSocket（wss）协议，当前引擎暂不支持',
    noteKey: 'tts.providerNote.iflytekSpark',
  },
  {
    id: 'stepfun',
    label: '阶跃星辰',
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
      { key: 'baseUrl', label: '接口地址', labelKey: 'tts.field.label.baseUrl', placeholder: 'https://api.stepfun.com/v1/audio/speech' },
      { key: 'apiKey', label: 'API Key', labelKey: 'tts.field.label.apiKey', secret: true, placeholder: 'sk-...' },
      { key: 'model', label: '模型名', labelKey: 'tts.field.label.model', placeholder: 'stepaudio-3-tts' },
      { key: 'voice', label: '音色', labelKey: 'tts.field.label.voice', optional: true, placeholder: '以官方音色列表为准', placeholderKey: 'tts.field.placeholder.voiceList' },
      { key: 'speed', label: '语速', labelKey: 'tts.field.label.speed', optional: true, placeholder: '1.0' },
    ],
    voices: ['cixingnansheng', 'zhaixiaowai'],
    timeoutMs: 30000,
    retries: 1,
    custom: true,
  },
  {
    id: 'tencent-cloud',
    label: '腾讯云',
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
      { key: 'appId', label: 'SecretId', labelKey: 'tts.field.label.secretId', placeholder: 'SecretId' },
      { key: 'apiKey', label: 'SecretKey', labelKey: 'tts.field.label.secretKey', secret: true, placeholder: 'SecretKey' },
      { key: 'region', label: '地域', labelKey: 'tts.field.label.region', optional: true, placeholder: 'ap-guangzhou' },
      { key: 'voice', label: '音色 ID', labelKey: 'tts.field.label.voiceId', optional: true, placeholder: '101001' },
      { key: 'speed', label: '语速', labelKey: 'tts.field.label.speed', optional: true, placeholder: '0' },
    ],
    timeoutMs: 30000,
    retries: 1,
    custom: true,
    unsupported: true,
    unsupportedNote: '腾讯云需要 TC3-HMAC-SHA256 签名，尚未实现',
    noteKey: 'tts.providerNote.tencentCloud',
  },
  {
    id: 'aliyun',
    // 端点是智能语音交互 NLS 网关（不是百炼 DashScope）：
    // 令牌必须来自智能语音交互控制台，百炼密钥打不通这个端点。
    label: '阿里云智能语音',
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
      { key: 'apiKey', label: '访问令牌', labelKey: 'tts.field.label.accessToken', secret: true, placeholder: '智能语音交互控制台获取', placeholderKey: 'tts.field.placeholder.aliyunToken' },
      { key: 'appId', label: 'AppKey', labelKey: 'tts.field.label.appKey', placeholder: '应用 AppKey', placeholderKey: 'tts.field.placeholder.appKey' },
      { key: 'voice', label: '音色', labelKey: 'tts.field.label.voice', optional: true, placeholder: 'xiaoyun' },
      { key: 'speed', label: '语速', labelKey: 'tts.field.label.speed', optional: true, placeholder: '0' },
    ],
    timeoutMs: 30000,
    retries: 1,
    custom: true,
  },
  {
    id: 'baidu',
    label: '百度智能云',
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
      { key: 'apiKey', label: 'API Key', labelKey: 'tts.field.label.apiKey', secret: true, placeholder: 'API Key' },
      { key: 'appSecretKey', label: 'Secret Key', labelKey: 'tts.field.label.appSecret', secret: true, placeholder: 'Secret Key' },
      { key: 'voice', label: '发音人', labelKey: 'tts.field.label.speaker', optional: true, placeholder: '0' },
      { key: 'speed', label: '语速', labelKey: 'tts.field.label.speed', optional: true, placeholder: '5' },
    ],
    timeoutMs: 30000,
    retries: 1,
    custom: true,
  },
  {
    id: 'volcano',
    label: '火山引擎',
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
      // 火山的官方字段名与讯飞/阿里云同义但措辞不同（AppID / Access Token），
      // 各留一条词条：共用一条会顺带改掉现有中文界面文案，属未请求的文案变更。
      { key: 'appId', label: 'AppID', labelKey: 'tts.field.label.volcanoAppId', placeholder: '应用 ID', placeholderKey: 'tts.field.placeholder.appId' },
      { key: 'apiKey', label: 'Access Token', labelKey: 'tts.field.label.volcanoToken', secret: true, placeholder: '访问令牌', placeholderKey: 'tts.field.placeholder.accessToken' },
      { key: 'voice', label: '音色', labelKey: 'tts.field.label.voice', optional: true, placeholder: 'BV001_streaming' },
      { key: 'speed', label: '语速', labelKey: 'tts.field.label.speed', optional: true, placeholder: '1.0' },
    ],
    timeoutMs: 30000,
    retries: 1,
    custom: true,
  },
  {
    id: 'minimax',
    label: 'MiniMax',
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
      { key: 'baseUrl', label: '接口地址', labelKey: 'tts.field.label.baseUrl', optional: true, placeholder: '国内 api.minimaxi.com；国际账号改 api.minimax.io', placeholderKey: 'tts.field.placeholder.minimaxBaseUrl' },
      { key: 'apiKey', label: 'API Key', labelKey: 'tts.field.label.apiKey', secret: true, placeholder: 'Bearer Token' },
      { key: 'appId', label: 'GroupId', labelKey: 'tts.field.label.groupId', placeholder: 'GroupId' },
      { key: 'model', label: '模型名', labelKey: 'tts.field.label.model', placeholder: 'speech-2.8-hd' },
      { key: 'voice', label: '音色', labelKey: 'tts.field.label.voice', optional: true, placeholder: '以官方音色列表为准', placeholderKey: 'tts.field.placeholder.voiceList' },
      { key: 'speed', label: '语速', labelKey: 'tts.field.label.speed', optional: true, placeholder: '1.0' },
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
