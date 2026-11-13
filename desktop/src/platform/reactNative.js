// react-native 别名（design.md「别名表」）：组件面刻意保持为零。
//
// 只导出共享层真正用到的**非组件** API：
// - Alert / Platform：错误提示与平台守卫（design.md 明确要求）；
// - PixelRatio / useWindowDimensions：ThemeContext 在模块加载与渲染期使用
//   （字号缩放与窗口尺寸）。它们是值/钩子，不是组件——View/Text 等仍然不可导入，
//   「偷偷复用 RN 组件」的退化路径依旧在构建期失败。
import { useEffect, useState } from 'react';

export { Alert } from './alert.js';
export { Platform } from './platform.js';

export const PixelRatio = Object.freeze({
  get: () => (typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1),
  getFontScale: () => 1,
  getPixelSizeForLayoutSize: size => Math.round(Number(size || 0) * (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1)),
  roundToNearestPixel: size => Math.round(Number(size || 0)),
});

export function useWindowDimensions() {
  const read = () => ({
    width: typeof window !== 'undefined' ? window.innerWidth : 1280,
    height: typeof window !== 'undefined' ? window.innerHeight : 800,
    scale: (typeof window !== 'undefined' && window.devicePixelRatio) || 1,
    fontScale: 1,
  });
  const [dimensions, setDimensions] = useState(read);
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onResize = () => setDimensions(read());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return dimensions;
}
