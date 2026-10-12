export const CHAT_API_VENDORS = [
  {
    id: 'deepseek',
    nameKey: 'apiVendor.deepseek.name',
    category: ['chat'],
    baseUrl: 'https://api.deepseek.com',
    protocol: 'openai',
    auth: { header: 'Authorization', prefix: 'Bearer ' },
    apiKeyUrl: 'https://platform.deepseek.com/api_keys',
    noteKey: 'apiVendor.deepseek.note',
  },
  {
    id: 'openrouter',
    nameKey: 'apiVendor.openrouter.name',
    category: ['chat'],
    baseUrl: 'https://openrouter.ai/api/v1',
    protocol: 'openai',
    auth: { header: 'Authorization', prefix: 'Bearer ' },
    apiKeyUrl: 'https://openrouter.ai/keys',
    noteKey: 'apiVendor.openrouter.note',
  },
  {
    id: 'anthropic',
    nameKey: 'apiVendor.anthropic.name',
    category: ['chat'],
    baseUrl: 'https://api.anthropic.com',
    protocol: 'anthropic',
    auth: { header: 'x-api-key', prefix: '' },
    apiKeyUrl: 'https://console.anthropic.com/settings/keys',
    noteKey: 'apiVendor.anthropic.note',
  },
  {
    id: 'openai',
    nameKey: 'apiVendor.openai.name',
    category: ['chat'],
    baseUrl: 'https://api.openai.com/v1',
    protocol: 'openai',
    auth: { header: 'Authorization', prefix: 'Bearer ' },
    apiKeyUrl: 'https://platform.openai.com/api-keys',
    noteKey: 'apiVendor.openai.note',
  },
  {
    id: 'modelscope',
    nameKey: 'apiVendor.modelscope.name',
    category: ['chat', 'image'],
    baseUrl: 'https://api-inference.modelscope.cn/v1',
    protocol: 'openai',
    auth: { header: 'Authorization', prefix: 'Bearer ' },
    apiKeyUrl: 'https://modelscope.cn/my/myaccesstoken',
    noteKey: 'apiVendor.modelscope.note',
  },
  {
    id: 'gitee-ai',
    nameKey: 'apiVendor.giteeAi.name',
    category: ['chat', 'image'],
    baseUrl: 'https://ai.gitee.com/v1',
    protocol: 'openai',
    auth: { header: 'Authorization', prefix: 'Bearer ' },
    apiKeyUrl: 'https://ai.gitee.com/dashboard/tokens',
    noteKey: 'apiVendor.giteeAi.note',
  },
  {
    id: 'agnes-ai',
    nameKey: 'apiVendor.agnesAi.name',
    category: ['chat', 'image'],
    baseUrl: 'https://apihub.agnes-ai.com/v1',
    protocol: 'openai',
    auth: { header: 'Authorization', prefix: 'Bearer ' },
    apiKeyUrl: 'https://platform.agnes-ai.com/',
    noteKey: 'apiVendor.agnesAi.note',
  },
  {
    id: 'dots-studio',
    nameKey: 'apiVendor.dotsStudio.name',
    category: ['chat'],
    baseUrl: 'https://note3-prev-api.askdiandian.com/v1',
    protocol: 'openai',
    auth: { header: 'api-key', prefix: '' },
    apiKeyUrl: 'https://dots.ai/platform/apikeys',
    noteKey: 'apiVendor.dotsStudio.note',
  },
  {
    id: 'nvidia-nim',
    nameKey: 'apiVendor.nvidiaNim.name',
    category: ['chat'],
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    protocol: 'openai',
    auth: { header: 'Authorization', prefix: 'Bearer ' },
    apiKeyUrl: 'https://build.nvidia.com/',
    noteKey: 'apiVendor.nvidiaNim.note',
  },
  {
    id: 'amd-radeon-cloud',
    nameKey: 'apiVendor.amdRadeonCloud.name',
    category: ['chat', 'image'],
    baseUrl: 'https://developer.amd.com.cn/radeon/api/v1',
    protocol: 'openai',
    auth: { header: 'Authorization', prefix: 'Bearer ' },
    apiKeyUrl: 'https://developer.amd.com.cn/radeon/tokenfactory',
    noteKey: 'apiVendor.amdRadeonCloud.note',
  },
];

export const API_PROTOCOL_PRESETS = [
  {
    id: 'openai',
    nameKey: 'apiProtocol.openai.name',
    protocol: 'openai',
    baseUrl: '',
    auth: { header: 'Authorization', prefix: 'Bearer ' },
    noteKey: 'apiProtocol.openai.note',
    disabled: false,
  },
  {
    id: 'openai-responses',
    nameKey: 'apiProtocol.openaiResponses.name',
    protocol: 'openai-responses',
    baseUrl: '',
    auth: { header: 'Authorization', prefix: 'Bearer ' },
    noteKey: 'apiProtocol.openaiResponses.note',
    disabled: false,
  },
  {
    id: 'anthropic',
    nameKey: 'apiProtocol.anthropic.name',
    protocol: 'anthropic',
    baseUrl: '',
    auth: { header: 'x-api-key', prefix: '' },
    noteKey: 'apiProtocol.anthropic.note',
    disabled: false,
  },
  {
    id: 'relay',
    nameKey: 'apiProtocol.relay.name',
    protocol: 'openai',
    baseUrl: '',
    auth: { header: 'Authorization', prefix: 'Bearer ' },
    noteKey: 'apiProtocol.relay.note',
    disabled: false,
  },
];

export const THIRD_PARTY_RELAY_RISK = [
  'apiVendor.relayRisk.0',
  'apiVendor.relayRisk.1',
  'apiVendor.relayRisk.2',
  'apiVendor.relayRisk.3',
  'apiVendor.relayRisk.4',
  'apiVendor.relayRisk.5',
  'apiVendor.relayRisk.6',
];

export function getChatApiVendor(id) {
  return CHAT_API_VENDORS.find(item => item.id === id) || null;
}

// 语音转文字（STT）厂商预设：一键预填端点与模型，避免用户自行查端点格式。
// 均为 OpenAI 兼容的 /audio/transcriptions 端点（POST multipart，Bearer 鉴权）。
export const TRANSCRIPTION_API_VENDORS = [
  {
    id: 'siliconflow-stt',
    nameKey: 'sttVendor.siliconflow.name',
    baseUrl: 'https://api.siliconflow.cn/v1/audio/transcriptions',
    model: 'FunAudioLLM/SenseVoiceSmall',
    apiKeyUrl: 'https://cloud.siliconflow.cn/account/ak',
    noteKey: 'sttVendor.siliconflow.note',
  },
  {
    id: 'groq-stt',
    nameKey: 'sttVendor.groq.name',
    baseUrl: 'https://api.groq.com/openai/v1/audio/transcriptions',
    model: 'whisper-large-v3-turbo',
    apiKeyUrl: 'https://console.groq.com/keys',
    noteKey: 'sttVendor.groq.note',
  },
  {
    id: 'openai-stt',
    nameKey: 'sttVendor.openai.name',
    baseUrl: 'https://api.openai.com/v1/audio/transcriptions',
    model: 'whisper-1',
    apiKeyUrl: 'https://platform.openai.com/api-keys',
    noteKey: 'sttVendor.openai.note',
  },
];

export function getTranscriptionVendor(id) {
  return TRANSCRIPTION_API_VENDORS.find(item => item.id === id) || null;
}
