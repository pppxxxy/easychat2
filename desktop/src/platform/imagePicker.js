// expo-image-picker 适配：桌面首版从本地文件选择图片（无相机）。
import { createLazyDefault } from './bridge.js';

const IMAGE_FILTERS = [{
  name: 'Images',
  extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'],
}];

export function createImagePicker(bridge) {
  return {
    launchImageLibraryAsync: async () => {
      const result = await bridge.dialog.open(IMAGE_FILTERS, false);
      if (result.canceled || !result.files || result.files.length === 0) {
        return { canceled: true, assets: null };
      }
      const file = result.files[0];
      return {
        canceled: false,
        assets: [{
          uri: `file:///${String(file.path).replace(/\\/g, '/').replace(/^\//, '')}`,
          fileName: file.name,
        }],
      };
    },
    requestMediaLibraryPermissionsAsync: async () => ({ status: 'granted', granted: true }),
  };
}

export default createLazyDefault(createImagePicker);
