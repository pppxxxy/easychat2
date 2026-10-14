// 一起听歌的角色评论 prompt：纯函数、中文（发给模型的提示词不做多语言翻译，
// 与 presets/forge 等提示词同一取舍）。角色人设由 buildRequestMessages 的 system
// 注入，这里只描述「正在听什么、听到哪」。

// 能力解析从**零依赖叶子**导入，而不是 storage/apiConfigs.js：
// 后者 import 了 ./io.js，io.js 又加载 `expo-file-system/legacy`——该子路径在 Node 下
// 不存在，一旦从这里引过去，本文件就再也无法被纯函数测试直接 import
//（tests/musicComments.test.mjs 正是直接 import 本文件）。叶子无依赖，两边都安全。
import { capabilitiesForModel, getActiveModel } from '../storage/modelCapabilities.js';

export function formatPlaybackPosition(ms) {
  const total = Math.max(0, Math.floor(Number(ms) || 0));
  const seconds = Math.floor(total / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  const pad = value => String(value).padStart(2, '0');
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(secs)}`;
  return `${minutes}:${pad(secs)}`;
}

function formatSongTimeline(positionMs, durationMs) {
  const duration = Math.max(0, Math.floor(Number(durationMs) || 0));
  if (duration <= 0) return `进度 ${formatPlaybackPosition(positionMs)}`;
  return `进度 ${formatPlaybackPosition(positionMs)}（全长 ${formatPlaybackPosition(duration)}）`;
}

// 打点评论：用户在时间轴上打了点，希望角色聊到这个位置时说点什么。
// withAudio=true 时该请求会附上整首歌的音频（多模态），提示词据此鼓励角色结合听到的内容。
export function buildTriggerCommentPrompt({ songName = '', positionMs = 0, durationMs = 0, note = '', withAudio = false } = {}) {
  const song = String(songName || '').trim() || '一首歌';
  const timeline = formatSongTimeline(positionMs, durationMs);
  const hint = String(note || '').trim();
  const request = hint
    ? `用户在这个位置打了个点，想听你聊聊：${hint}。`
    : '用户在这个位置打了个点，想听你聊聊此刻这段音乐。';
  const hearing = withAudio
    ? '这条消息随附了这首歌的音频，你已经听到了它。'
    : '';
  return [
    `你和用户正在一起听歌，当前播放：《${song}》，${timeline}。`,
    hearing,
    request,
    '请用一两句口语化的中文说出你此刻的感受或想陪用户聊的话，像随口聊天一样自然；不要复述进度信息，不要使用任何格式标记，直接输出要说的话。',
  ].filter(Boolean).join('');
}

// 开场评论：歌曲刚开始播放时的陪伴开场白。
// withAudio=true 时该请求会附上整首歌的音频（多模态）。
export function buildOpeningCommentPrompt({ songName = '', durationMs = 0, withAudio = false } = {}) {
  const song = String(songName || '').trim() || '一首歌';
  const timeline = formatSongTimeline(0, durationMs);
  const hearing = withAudio
    ? '这条消息随附了这首歌的音频，你已经听到了它。'
    : '';
  return [
    `你和用户正在一起听歌，《${song}》刚开始播放，${timeline}。`,
    hearing,
    '请用一两句口语化的中文自然地开场，说出你对这首歌的第一感受或想陪用户听歌的心情；不要复述进度信息，不要使用任何格式标记，直接输出要说的话。',
  ].filter(Boolean).join('');
}

// 不裁剪、整首直接发送时的原始文件体积上限：超过退回纯文字评论。
// 一首 5 分钟 320kbps MP3 约 12MB，base64 后约 16MB；25MB 留出余量。
export const MUSIC_AUDIO_MAX_BYTES = 25 * 1024 * 1024;

// 允许送进 WebView 解码裁剪的原始文件体积上限：裁剪后只发 30 秒，可放宽到 80MB。
// 超过则退回整首发送（若在 25MB 内）或纯文字。
export const MUSIC_DECODE_MAX_BYTES = 80 * 1024 * 1024;

// 歌曲是否可随消息附给模型：有 uri 且体积不超上限。纯体积判断，不读盘。
// maxBytes 默认整首发送上限；裁剪路径可传 MUSIC_DECODE_MAX_BYTES。
export function canAttachSongAudio(song, maxBytes = MUSIC_AUDIO_MAX_BYTES) {
  const source = song && typeof song === 'object' ? song : {};
  const uri = String(source.uri || '');
  if (!uri) return false;
  const size = Math.max(0, Math.floor(Number(source.size)) || 0);
  const limit = Number(maxBytes) > 0 ? Number(maxBytes) : MUSIC_AUDIO_MAX_BYTES;
  return size > 0 && size <= limit;
}

// 取出当前生效的在线配置（按 activeId，失配退回首个）。拿不到返回 null。
export function resolveActiveApiConfig(apiConfig) {
  return apiConfig && Array.isArray(apiConfig.configs)
    ? (apiConfig.configs.find(item => item.id === apiConfig.activeId) || apiConfig.configs[0] || null)
    : null;
}

// **仅在线**部分的能力判定：当前模型是否声明了 supportsAudio。
//
// 单独抽出来是因为在线/本地两条链路必须各用**自己的**判据，不能合并：
//   · 在线消息（filterRequestMedia 的 onlineMessages）只该看在线模型能力；
//   · 本地消息只看本地模型能力（另有独立实现）。
// 若在线路径误用「在线或本地」的合并结果，就会出现「本地模型能听 → 音频被保留 →
// 却发给了一个不支持音频的在线模型」。纯函数，便于 Node 直测。
export function resolveOnlineAudioSupport(apiConfig) {
  const current = resolveActiveApiConfig(apiConfig);
  if (!current) return false;
  return capabilitiesForModel(current, getActiveModel(current)).supportsAudio === true;
}

// 当前来源是否具备「听音频」能力：在线配置的**当前模型**声明 supportsAudio，或本地活动
// 模型可推理且带音频 mmproj 并开启了媒体输入（与聊天附件同口径）。纯函数便于 Node 直测。
//
// ⚠️ 能力按**模型**解析，不能读配置级 supportsAudio：
// 现行「确认模型能力」编辑器只写 config.modelCapabilities[模型名]
//（SettingsScreen 的 updateField({ modelCapabilities }），见 storage/apiConfigs 顶部注释），
// 配置级 supportsAudio 是**只为旧数据兼容保留**的字段——新配置上它恒为 false。
// 旧实现读它 ⇒ 用户在能力弹层里打开的「支持语音识别」永远无效：听歌横幅一直显示
// 「不具备听音频能力」、片段时长/采样率设置永不出现、音频永不随评论发送。
// 聊天侧早已迁移到逐模型口径（chat/useChatSend 的 capabilitiesForModel），听歌侧此前被漏掉。
//
// 旧数据无需特殊处理：normalizeModelCapabilities 在 modelCapabilities 缺失时，
// 会按配置级旧字段给每个已有模型物化一份条目（legacy 回落），所以这里统一走
// capabilitiesForModel 即可，不要再额外加一层配置级读取（那会让两套口径重新分叉）。
export function resolveAudioSupport(apiConfig, localMedia) {
  const online = resolveOnlineAudioSupport(apiConfig);
  const local = !!(localMedia && localMedia.audio);
  return online || local;
}
