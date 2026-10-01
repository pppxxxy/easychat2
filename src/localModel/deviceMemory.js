// 读取设备内存信息，供本地模型兼容分级使用（含 expo-device 原生依赖）。
import * as Device from 'expo-device';

// 返回 { totalMemoryBytes }；读取失败或平台不支持时为 0。
export function getDeviceMemoryInfo() {
  try {
    const total = Device && typeof Device.totalMemory === 'number' ? Device.totalMemory : 0;
    return { totalMemoryBytes: total > 0 ? total : 0 };
  } catch (error) {
    return { totalMemoryBytes: 0 };
  }
}
