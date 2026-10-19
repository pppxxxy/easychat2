// `expo-image-picker` 的 Node 端桩。
//
// 同 expo-document-picker：真实模块经 expo-modules-core（.ts）进来，Node 无法加载。
// 默认返回取消，不编造假图片。
//
// 纪律：只实现被用到的形状，未实现显式抛错。

export const calls = [];

export async function launchImageLibraryAsync(options) {
  calls.push(['launchImageLibraryAsync', options]);
  return { canceled: true, assets: null };
}

export async function launchCameraAsync(options) {
  calls.push(['launchCameraAsync', options]);
  return { canceled: true, assets: null };
}

export async function requestCameraPermissionsAsync() {
  calls.push(['requestCameraPermissionsAsync']);
  return { status: 'undetermined', granted: false };
}

export async function requestMediaLibraryPermissionsAsync() {
  calls.push(['requestMediaLibraryPermissionsAsync']);
  return { status: 'undetermined', granted: false };
}

export const MediaTypeOptions = { Images: 'Images', Videos: 'Videos', All: 'All' };

export default {
  launchImageLibraryAsync,
  launchCameraAsync,
  requestCameraPermissionsAsync,
  requestMediaLibraryPermissionsAsync,
  MediaTypeOptions,
};
