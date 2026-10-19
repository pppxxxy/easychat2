// `expo-sharing` 的 Node 端桩。
//
// 同 expo-clipboard：真实模块经 expo-modules-core 的 .ts 进来，Node 无法加载。
// 渲染测试只需要「分享被触发过」这一事实（以及传了什么 uri）。
//
// 纪律：未实现的形状显式抛错，不静默返回假值。

export const calls = [];

export async function isAvailableAsync() {
  // Node 里没有系统分享面板；如实返回 false，让调用方走「无法分享」分支。
  return false;
}

export async function shareAsync(uri, options) {
  calls.push(['shareAsync', String(uri), options]);
  return { action: 'sharedAction' };
}

export default { isAvailableAsync, shareAsync };
