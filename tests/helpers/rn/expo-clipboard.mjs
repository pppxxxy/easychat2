// `expo-clipboard` 的 Node 端桩。
//
// 真实模块经 `expo-modules-core` 的 src/index.ts 进来，Node 会抛
// ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING（node_modules 下不做类型剥离）。
// 渲染测试不需要真剪贴板，只需要「调用了什么」可观察。
//
// 与其它桩同一纪律：只实现被用到的形状，未实现的**显式抛错**，不静默返回假值。

export const calls = [];

export async function setStringAsync(text) {
  calls.push(['setStringAsync', String(text)]);
  return true;
}

export async function getStringAsync() {
  calls.push(['getStringAsync']);
  return '';
}

export function setString(text) {
  calls.push(['setString', String(text)]);
}

export default { setStringAsync, getStringAsync, setString };
