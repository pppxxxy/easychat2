// expo-asset 适配（design.md「共享层复用清单 A-2」）：打包资源的最小占位实现。
//
// 桌面首版不复用 expo-asset 的打包资源形态：defaultCharacterAssets 会被注入
// artworkLoader（从 desktop/assets 直接复制到 avatars/）。本模块只在注入遗漏时被
// Asset.fromModule 调到——返回一个「下载不做事、localUri 为空」的对象，
// 让共享层的容错分支按「图片不可用」处理，而不是在 import 期抛错。
export class Asset {
  constructor(moduleRef) {
    this.moduleRef = moduleRef;
    this.localUri = null;
    this.uri = null;
    this.downloaded = false;
  }

  static fromModule(moduleRef) {
    return new Asset(moduleRef);
  }

  async downloadAsync() {
    this.downloaded = true;
    return this;
  }
}

export default { Asset };
