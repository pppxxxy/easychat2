// 新手教学截图注册表。
//
// 新增截图步骤：
// 1. 把 PNG/JPG 放到 assets/onboarding/，文件名与下方键名一致（如 chat-api.png / chat-ui.jpg）。
// 2. 在 IMAGES 中按 `'chat-api': require('../../assets/onboarding/chat-api.png')` 注册。
//
// 未注册的键返回 null，界面会自动跳过图片，因此可以先写章节文案、后补截图。
// 注意：只能使用静态 require，Metro 不支持动态拼路径。

const IMAGES = {
  'chat-ui': require('../../assets/onboarding/chat-ui.jpg'),
  'chat-ui-menu': require('../../assets/onboarding/chat-ui-menu.jpg'),
  'chat-ui-empty': require('../../assets/onboarding/chat-ui-empty.jpg'),
  'character-card': require('../../assets/onboarding/character-card.jpg'),
  'character-edit': require('../../assets/onboarding/character-edit-form.jpg'),
  'character-library': require('../../assets/onboarding/character-library.jpg'),
  memory: require('../../assets/onboarding/memory.jpg'),
  'image-api': require('../../assets/onboarding/image-api.jpg'),
  'image-api-key': require('../../assets/onboarding/image-api-key.jpg'),
  games: require('../../assets/onboarding/games.jpg'),
  'chat-api': require('../../assets/onboarding/chat-api.jpg'),
  moments: require('../../assets/onboarding/moments.jpg'),
  'vector-api': require('../../assets/onboarding/vector-api.jpg'),
  'user-persona': require('../../assets/onboarding/user-persona.jpg'),
  'inline-image': require('../../assets/onboarding/inline-image.jpg'),
  // ── 2026-10-23 补齐：此前完全没有教学的 12 个功能模块 ──
  // 工作区拆两张：文件页签是主界面，终端是「能跑命令」这一能力的证据。
  workspace: require('../../assets/onboarding/workspace.jpg'),
  'workspace-terminal': require('../../assets/onboarding/workspace-terminal.jpg'),
  mcp: require('../../assets/onboarding/mcp.jpg'),
  music: require('../../assets/onboarding/music.jpg'),
  books: require('../../assets/onboarding/books.jpg'),
  map: require('../../assets/onboarding/map.jpg'),
  // 语音同样拆两张：播报（TTS）与转写（ASR）是两个独立配置面板，
  // 合成一章讲但界面完全不同，一张图说不清。
  'voice-tts': require('../../assets/onboarding/voice-tts.jpg'),
  'voice-asr': require('../../assets/onboarding/voice-asr.jpg'),
  // 主动消息：顶部是全局默认，展开单个时段才有风格权重与自定义文案。
  proactive: require('../../assets/onboarding/proactive.jpg'),
  'proactive-time': require('../../assets/onboarding/proactive-time.jpg'),
  schedule: require('../../assets/onboarding/schedule.jpg'),
  diary: require('../../assets/onboarding/diary.jpg'),
  plugin: require('../../assets/onboarding/plugin.jpg'),
  backup: require('../../assets/onboarding/backup.jpg'),
  security: require('../../assets/onboarding/security.jpg'),
  // 顺带补上 local-model 章节缺图（该章此前 image 键未注册，界面一直跳过）。
  'local-model': require('../../assets/onboarding/local-model.jpg'),
  'local-model-get': require('../../assets/onboarding/local-model-get.jpg'),
  'local-model-api': require('../../assets/onboarding/local-model-api.jpg'),
};

export function getOnboardingImage(key) {
  if (!key) return null;
  return IMAGES[key] || null;
}

// 解析章节的图片列表：优先用 images（[{ key, caption }]），否则回退单个 image。
// 返回 [{ source, caption }]，已过滤掉未注册/无效项。
export function getOnboardingImages(chapter) {
  if (!chapter) return [];
  const resolve = items => items
    .map(item => {
      const key = typeof item === 'string' ? item : item?.key;
      const source = getOnboardingImage(key);
      if (!source) return null;
      const caption = typeof item === 'string' ? '' : String(item?.caption || '');
      return { source, caption };
    })
    .filter(Boolean);

  const list = Array.isArray(chapter.images) && chapter.images.length > 0
    ? resolve(chapter.images)
    : [];
  if (list.length > 0) return list;
  return chapter.image ? resolve([{ key: chapter.image }]) : [];
}

export default IMAGES;
