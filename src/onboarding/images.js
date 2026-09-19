// 新手教学截图注册表。
//
// 新增截图步骤：
// 1. 把 PNG 放到 assets/onboarding/，文件名与下方键名一致（如 chat-api.png）。
// 2. 在 IMAGES 中按 `'chat-api': require('../../assets/onboarding/chat-api.png')` 注册。
//
// 未注册的键返回 null，界面会自动跳过图片，因此可以先写章节文案、后补截图。
// 注意：只能使用静态 require，Metro 不支持动态拼路径。

const IMAGES = {
  // 'chat-api': require('../../assets/onboarding/chat-api.png'),
};

export function getOnboardingImage(key) {
  if (!key) return null;
  return IMAGES[key] || null;
}

export default IMAGES;
