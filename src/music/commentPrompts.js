// 一起听歌的角色评论 prompt：纯函数、中文（发给模型的提示词不做多语言翻译，
// 与 presets/forge 等提示词同一取舍）。角色人设由 buildRequestMessages 的 system
// 注入，这里只描述「正在听什么、听到哪」。

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

// 附音频的体积上限（原始文件字节）：超过则放弃附音频，退回纯文字评论。
// 一首 5 分钟 320kbps MP3 约 12MB，base64 后约 16MB；25MB 留出余量。
export const MUSIC_AUDIO_MAX_BYTES = 25 * 1024 * 1024;

// 歌曲是否可随消息附给模型：有 uri 且体积不超上限。纯体积判断，不读盘。
export function canAttachSongAudio(song) {
  const source = song && typeof song === 'object' ? song : {};
  const uri = String(source.uri || '');
  if (!uri) return false;
  const size = Math.max(0, Math.floor(Number(source.size)) || 0);
  return size > 0 && size <= MUSIC_AUDIO_MAX_BYTES;
}

// 当前来源是否具备「听音频」能力。一起听歌的评论与动态/看屏幕评论一致，走在线 API
// 配置（sendChatMessage），故以在线配置的 supportsAudio 为准。纯函数便于 Node 直测。
export function resolveAudioSupport(apiConfig) {
  const current = apiConfig && Array.isArray(apiConfig.configs)
    ? (apiConfig.configs.find(item => item.id === apiConfig.activeId) || apiConfig.configs[0])
    : null;
  return !!(current && current.supportsAudio === true);
}
