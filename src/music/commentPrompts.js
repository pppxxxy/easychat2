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
export function buildTriggerCommentPrompt({ songName = '', positionMs = 0, durationMs = 0, note = '' } = {}) {
  const song = String(songName || '').trim() || '一首歌';
  const timeline = formatSongTimeline(positionMs, durationMs);
  const hint = String(note || '').trim();
  const request = hint
    ? `用户在这个位置打了个点，想听你聊聊：${hint}。`
    : '用户在这个位置打了个点，想听你聊聊此刻这段音乐。';
  return [
    `你和用户正在一起听歌，当前播放：《${song}》，${timeline}。`,
    request,
    '请用一两句口语化的中文说出你此刻的感受或想陪用户聊的话，像随口聊天一样自然；不要复述进度信息，不要使用任何格式标记，直接输出要说的话。',
  ].join('');
}

// 开场评论：歌曲刚开始播放时的陪伴开场白。
export function buildOpeningCommentPrompt({ songName = '', durationMs = 0 } = {}) {
  const song = String(songName || '').trim() || '一首歌';
  const timeline = formatSongTimeline(0, durationMs);
  return [
    `你和用户正在一起听歌，《${song}》刚开始播放，${timeline}。`,
    '请用一两句口语化的中文自然地开场，说出你对这首歌的第一感受或想陪用户听歌的心情；不要复述进度信息，不要使用任何格式标记，直接输出要说的话。',
  ].join('');
}

// 当前来源是否具备「听音频」能力：在线配置标记 supportsAudio，或本地活动模型带
// 音频 mmproj 且用户开启媒体输入（localMedia.audio 已含开关判定）。纯函数便于 Node 直测。
// 注意：一起听歌的评论只送歌名+进度，本函数仅用于界面提示「角色听不到音频」。
export function resolveAudioSupport(apiConfig, localMedia) {
  const current = apiConfig && Array.isArray(apiConfig.configs)
    ? (apiConfig.configs.find(item => item.id === apiConfig.activeId) || apiConfig.configs[0])
    : null;
  return !!(current && current.supportsAudio === true) || !!(localMedia && localMedia.audio);
}
