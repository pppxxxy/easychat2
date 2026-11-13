// expo-speech 适配：桌面首版不支持 TTS（capabilities.voicePlayback=false）。
import { unsupportedCapability } from './unsupported.js';

export const speak = () => {
  throw unsupportedCapability('expo-speech.speak');
};
export const stop = async () => {};
export const getAvailableVoicesAsync = async () => [];

export default { speak, stop, getAvailableVoicesAsync };
