// expo-document-picker 适配：走主进程原生对话框。
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
        assets: result.files.map(file => ({ uri: file.uri, name: file.name })),
      };
    },
  };
}

const bridge = typeof globalThis !== 'undefined' ? globalThis.easychat2 : null;
const instance = bridge ? createDocumentPicker(bridge) : null;
const ensure = () => {
  if (!instance) throw new Error('desktop bridge unavailable');
  return instance;
};

export const getDocumentAsync = (...args) => ensure().getDocumentAsync(...args);

export default instance || { getDocumentAsync };
