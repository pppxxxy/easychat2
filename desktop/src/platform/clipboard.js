// expo-clipboard 适配：写走主进程（Electron clipboard），读走 navigator.clipboard。
export function createClipboard(bridge) {
  return {
    setStringAsync: async text => {
      await bridge.clipboard.write(String(text ?? ''));
    },
    getStringAsync: async () => {
      if (typeof navigator !== 'undefined' && navigator.clipboard) return navigator.clipboard.readText();
      return '';
    },
  };
}

const bridge = typeof globalThis !== 'undefined' ? globalThis.easychat2 : null;
const instance = bridge ? createClipboard(bridge) : null;
const ensure = () => {
  if (!instance) throw new Error('desktop bridge unavailable');
  return instance;
};

export const setStringAsync = (...args) => ensure().setStringAsync(...args);
export const getStringAsync = (...args) => ensure().getStringAsync(...args);

export default instance || { setStringAsync, getStringAsync };
