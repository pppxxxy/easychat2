// OAuth 网页认证的 RN 侧桥：用系统浏览器打开授权页，经 app scheme 深链捕获回调。
//
// 为什么不用 expo-auth-session/expo-web-browser：两者都是原生模块，要重新 prebuild；
// app.json 的 scheme（easychat2）+ Linking 就能完成「跳网页认证 → 带码跳回」，
// 零新增原生依赖（CI 构建风险最小化——项目有过 Kotlin 编译失败前科）。
//
// 生命周期：设置页点「网页认证」→ openSystemBrowser(授权URL) → 用户在 GitHub
// 授权 → 浏览器 302 到 easychat2://github-mcp-callback?code=... → 监听拿到回调。
// 用户中途返回 App 而没完成授权时，Promise 会在超时后拒绝（UI 可重试）。

import { Linking } from 'react-native';

export const GITHUB_OAUTH_REDIRECT = 'easychat2://github-mcp-callback';
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

export async function openSystemBrowser(url) {
  const supported = await Linking.canOpenURL(url).catch(() => false);
  if (!supported && !/^https:\/\//.test(String(url))) {
    const error = new Error('cannot open the authorization page');
    error.code = 'OAUTH_BROWSER_UNAVAILABLE';
    throw error;
  }
  await Linking.openURL(url);
}

// 等待回调 URL。已安装/冷启动两种路径都覆盖：监听 'url' 事件 +
// getInitialURL 兜底（浏览器跳回时 App 已在后台则事件可能不触发）。
export function captureOAuthCallback({ timeoutMs = CALLBACK_TIMEOUT_MS, initialUrl = null } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let subscription = null;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      if (subscription && typeof subscription.remove === 'function') subscription.remove();
      clearTimeout(timer);
      fn(value);
    };
    const handleUrl = url => {
      if (!url || settled) return;
      const text = String(url);
      if (text.startsWith('easychat2://github-mcp-callback')) settle(resolve, text);
    };
    subscription = Linking.addEventListener('url', event => handleUrl(event && event.url));
    // 事件监听注册前的落队回调（极端竞态）：再查一次 initialURL。
    Linking.getInitialURL()
      .then(url => { if (!settled) handleUrl(url); })
      .catch(() => {});
    if (initialUrl) handleUrl(initialUrl);
    const timer = setTimeout(() => {
      const error = new Error('oauth callback timeout');
      error.code = 'OAUTH_TIMEOUT';
      settle(reject, error);
    }, timeoutMs);
  });
}
