// `expo-document-picker` 的 Node 端桩。
//
// 真实模块的 build/index.js 用无扩展名相对导入（ExpoDocumentPicker），Node 解析不到。
// 渲染测试不该真的弹系统文件选择器，只需可观察「被调用过」。
//
// 纪律：默认返回取消（canceled），让调用方走「用户没选」分支——不编造一个假文件。

export const calls = [];

export async function getDocumentAsync(options) {
  calls.push(['getDocumentAsync', options]);
  return { canceled: true, assets: null };
}

export default { getDocumentAsync };
