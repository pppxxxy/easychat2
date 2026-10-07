// 生图 provider id 归一化的共享叶子：imageGen 与 inlineImage 都用它按白名单过滤。
// 从 src/storage/settings.js 原样外提（无行为变化）。

import { isKnownImageProvider } from '../../imageGen/providers.js';

export function normalizeImageProviderId(value) {
  const id = String(value || '');
  return isKnownImageProvider(id) ? id : '';
}
