// `expo-asset` 的 Node 端桩。
//
// 真实模块的 build/index.js 用了 Metro 专属的 `.fx` 后缀解析，Node 直接抛
// ERR_MODULE_NOT_FOUND（找不到 Asset.fx）。渲染测试只关心「资源有没有被预载」，
// 不关心真实打包产物，所以这里给最小可用形状。
//
// 纪律：未实现的形状显式抛错，不静默返回假值。

export class Asset {
  constructor(downloadUrl, localUri, name, type, hash, width, height) {
    this.downloadUrl = downloadUrl;
    this.localUri = localUri;
    this.name = name;
    this.type = type;
    this.hash = hash;
    this.width = width;
    this.height = height;
    this.downloaded = false;
  }

  static fromModule() {
    return new Asset();
  }

  static loadAsync() {
    return Promise.resolve([]);
  }

  async downloadAsync() {
    this.downloaded = true;
    return this;
  }
}

export default { Asset };
