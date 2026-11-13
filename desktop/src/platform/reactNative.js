// react-native 别名（design.md「别名表」）：组件面刻意保持为零。
//
// 只导出共享层真正用到的**非组件** API：
// - Alert / Platform：错误提示与平台守卫（design.md 明确要求）；
// - PixelRatio / useWindowDimensions：ThemeContext 在模块加载与渲染期使用
//   （字号缩放与窗口尺寸）。它们是值/钩子，不是组件——View/Text 等仍然不可导入，
//   「偷偷复用 RN 组件」的退化路径依旧在构建期失败。
import { useEffect, useState } from 'react';

import { mediaUrl } from './mediaUrl.js';

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

// 仅静态方法：共享层（chat/attachments.js）用 Image.getSize 探测本地图片尺寸。
// 刻意不提供组件形态（`<Image/>` 用法不会得到 RN 的组件，桌面界面用自己的 <img>）；
// 本地 file:// 先转 easychat2-media:// 再交给 DOM 加载，与界面渲染同一套协议。
export const Image = Object.freeze({
  getSize(uri, success, failure) {
    const src = mediaUrl(uri) || String(uri || '');
    if (!src) {
      if (typeof failure === 'function') failure(new Error('empty image uri'));
      return;
    }
    const probe = new globalThis.Image();
    probe.onload = () => {
      if (typeof success === 'function') success(probe.naturalWidth || probe.width, probe.naturalHeight || probe.height);
    };
    probe.onerror = () => {
      if (typeof failure === 'function') failure(new Error(`image load failed: ${src}`));
    };
    probe.src = src;
  },
  prefetch() {
    // 渲染进程无需预取（图片走自定义协议，本地读取无网络成本）。
  },
});
