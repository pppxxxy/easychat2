// expo-document-picker 适配：走主进程原生对话框。
import { createLazyDefault } from './bridge.js';

export function createDocumentPicker(bridge) {
  return {
    getDocumentAsync: async ({ type, multiple } = {}) => {
      const filters = type && Array.isArray(type)
        ? [{ name: 'Files', extensions: type }]
        : undefined;
      const result = await bridge.dialog.open(filters, !!multiple);
      if (result.canceled || !result.files || result.files.length === 0) {
        return { canceled: true, assets: null };
      }
      return {
        canceled: false,
        assets: result.files.map(file => ({ uri: `file:///${String(file.path).replace(/\\/g, '/').replace(/^\//, '')}`, name: file.name })),
      };
    },
  };
}

export default createLazyDefault(createDocumentPicker);
