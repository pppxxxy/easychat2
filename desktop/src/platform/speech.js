// expo-speech 适配：桌面首版不支持 TTS。
import { makeUnsupportedModule } from './unsupported.js';

export default makeUnsupportedModule('expo-speech', ['speak', 'stop', 'getAvailableVoicesAsync']);
