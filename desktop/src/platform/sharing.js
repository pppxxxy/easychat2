// expo-sharing 适配：桌面首版用「在文件夹中显示」替代系统分享面板。
import { createLazyDefault } from './bridge.js';

export function createSharing(bridge) {
  return {
    isAvailableAsync: async () => true,
    shareAsync: async uri => {
      await bridge.dialog.reveal(uri);
    },
  };
}

export default createLazyDefault(createSharing);
