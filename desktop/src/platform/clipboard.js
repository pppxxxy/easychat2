// expo-clipboard 适配：写走主进程（Electron clipboard），读走 navigator.clipboard。
import { createLazyDefault } from './bridge.js';

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

export default createLazyDefault(createClipboard);
