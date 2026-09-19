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
};

export function getOnboardingImage(key) {
  if (!key) return null;
  return IMAGES[key] || null;
}

export default IMAGES;
