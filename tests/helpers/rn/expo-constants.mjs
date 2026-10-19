// `expo-constants` 的 Node 端桩。
//
// 真实模块经 expo-modules-core（.ts）进来，Node 无法加载。渲染测试只需
// expoConfig.version 之类的基本字段；缺哪个由调用方显式报错，不静默编造版本号。

const Constants = {
  expoConfig: {
    version: '0.0.0-test',
    name: 'easychat2',
    slug: 'easychat2',
  },
  manifest: null,
  manifest2: null,
  expoVersion: '0.0.0-test',
  platform: { android: {}, ios: {} },
};

export default Constants;
export const { expoConfig, manifest, manifest2, expoVersion, platform } = Constants;
