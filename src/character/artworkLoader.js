// 内置角色头像/背景的落盘入口：**可注入实现**（design.md「共享层复用清单 A-2」）。
//
// 为什么单独成文件：`defaultCharacterAssets.js` 顶层是
// `require('../../assets/easychat-assistant-avatar.jpg')` 这种 CJS 资源加载，
// ESM 打包器（Vite/Rollup）无法执行；而 `AppContext` 只需要「把内置图落盘」这一步，
// 不该把资源加载带进依赖图。桌面端在启动时注入自己的实现（主进程把打包资源复制到
// avatars/），Android 端由 defaultCharacterAssets.js 在模块加载时注册原实现。
//
// 注册式而非参数式的原因：AppContext 的调用点在 async 回调里，没有地方传参；
// 注册一次、全局可用的语义与 src/i18n 的 setActiveLocale 同型。
let loader = null;

export function setArtworkLoader(next) {
  loader = typeof next === 'function' ? next : null;
}

// 返回 { avatarUri, bgUri }；失败项为 ''（与既有实现一致）。
// 未注册实现（桌面端在极早期调用、或测试环境）返回空串，调用方按「图片不可用」处理。
export async function materializeDefaultArtwork() {
  if (!loader) return { avatarUri: '', bgUri: '' };
  try {
    const result = await loader();
    return {
      avatarUri: (result && result.avatarUri) || '',
      bgUri: (result && result.bgUri) || '',
    };
  } catch (error) {
    return { avatarUri: '', bgUri: '' };
  }
}
