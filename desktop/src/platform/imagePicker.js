// expo-image-picker 适配：桌面首版从本地文件选择图片（无相机）。
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
          uri: file.uri,
          fileName: file.name,
        }],
      };
    },
    requestMediaLibraryPermissionsAsync: async () => ({ status: 'granted', granted: true }),
  };
}

const bridge = typeof globalThis !== 'undefined' ? globalThis.easychat2 : null;
const instance = bridge ? createImagePicker(bridge) : null;
const ensure = () => {
  if (!instance) throw new Error('desktop bridge unavailable');
  return instance;
};

export const launchImageLibraryAsync = (...args) => ensure().launchImageLibraryAsync(...args);
export const requestMediaLibraryPermissionsAsync = (...args) => ensure().requestMediaLibraryPermissionsAsync(...args);

export default instance || { launchImageLibraryAsync, requestMediaLibraryPermissionsAsync };

// 相机相关：桌面没有相机（capabilities 关闭），但共享层以命名导入引用这些成员，
// 必须导出同名符号（调用时返回「已取消 / 未授权」，绝不抛错打断调用方）。
export const MediaTypeOptions = Object.freeze({ All: 'All', Images: 'Images', Videos: 'Videos' });
export const CameraType = Object.freeze({ front: 'front', back: 'back' });
export const getPendingResultAsync = async () => null;
export const getCameraPermissionsAsync = async () => ({ status: 'denied', granted: false });
export const requestCameraPermissionsAsync = async () => ({ status: 'denied', granted: false });
export const launchCameraAsync = async () => ({ canceled: true, assets: null });
