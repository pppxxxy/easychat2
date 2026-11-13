// expo-sharing 适配：桌面首版用「在文件夹中显示」替代系统分享面板。
export function createSharing(bridge) {
  return {
    isAvailableAsync: async () => true,
    shareAsync: async uri => {
      await bridge.dialog.reveal(uri);
    },
  };
}

const bridge = typeof globalThis !== 'undefined' ? globalThis.easychat2 : null;
const instance = bridge ? createSharing(bridge) : null;
const ensure = () => {
  if (!instance) throw new Error('desktop bridge unavailable');
  return instance;
};

export const isAvailableAsync = (...args) => ensure().isAvailableAsync(...args);
export const shareAsync = (...args) => ensure().shareAsync(...args);

export default instance || { isAvailableAsync, shareAsync };
