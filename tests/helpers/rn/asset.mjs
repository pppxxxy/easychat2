// 图片/字体等**静态资源**的 Node 端桩。
//
// 为什么需要：仓库里有 `require('../../assets/xxx.jpg')`（defaultCharacterAssets.js）
// 和 `import ... from '../../assets/xxx.png'` 这类写法——Metro 打包器会把它们变成
// 资源 id，Node 不认识这些扩展名，直接抛 Unknown file extension。
//
// 桩的形状对齐 RN 的 Asset 来源（{ uri, width, height }），并给一个可辨认的 uri，
// 便于断言「用了哪张图」。
//
// 纪律：不编造真实像素，只给稳定的占位 uri。

const ASSET_URI_PREFIX = 'file:///assets/';

const asset = {
  uri: `${ASSET_URI_PREFIX}placeholder.png`,
  width: 1,
  height: 1,
  type: 'png',
};

export default asset;
export { asset };
