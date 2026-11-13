// expo-device 适配：只提供共享层用到的总内存读取。
import os from 'node:os';

export const totalMemory = os.totalmem();
export const isDevice = false;

export default { totalMemory, isDevice };
