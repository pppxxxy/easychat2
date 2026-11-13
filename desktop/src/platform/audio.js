// expo-audio 适配：桌面首版不支持语音（design.md「首版能力降级」）。
// 导入不炸、调用给结构化错误，由界面的 capabilities.js 禁用态兜住。
import { makeUnsupportedModule } from './unsupported.js';

export const createAudioPlayer = () => {
  const error = new Error('voice playback is not available on desktop in this release');
  error.code = 'CAPABILITY_UNAVAILABLE';
  throw error;
};

export const setAudioModeAsync = async () => {};

export default makeUnsupportedModule('expo-audio', ['requestRecordingPermissionsAsync', 'setAudioModeAsync']);
