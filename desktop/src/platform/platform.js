// Platform 适配：共享层的守卫全部以 Platform.OS 判断平台。
// 桌面返回 'windows'，使既有 `Platform.OS === 'android'` / `!== 'android'` 的
// Android 专属分支自动关闭（design.md Requirement 3.7）。
const OS = 'windows';

export const Platform = Object.freeze({
  OS,
  select(map) {
    if (!map || typeof map !== 'object') return undefined;
    if (Object.prototype.hasOwnProperty.call(map, OS)) return map[OS];
    if (Object.prototype.hasOwnProperty.call(map, 'native')) return map.native;
    return map.default;
  },
  Version: undefined,
  isPad: false,
  isTV: false,
  isTesting: false,
  constants: Object.freeze({ reactNativeVersion: undefined }),
});
