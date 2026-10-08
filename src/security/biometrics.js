// 生物识别能力的原生封装（expo-local-authentication）。
//
// 只在应用锁路径调用；惰性 require + 全量 try/catch，让没有该原生模块的环境
// （如某些 Expo Go / Node 测试）不至于在加载期崩溃，而是降级为「不可用」。

let localAuthModule;
let localAuthLoaded = false;

function getLocalAuth() {
  if (!localAuthLoaded) {
    localAuthLoaded = true;
    try {
      localAuthModule = require('expo-local-authentication');
    } catch (error) {
      localAuthModule = null;
    }
  }
  return localAuthModule;
}

export function isBiometricSupported() {
  const module = getLocalAuth();
  return !!(module && typeof module.hasHardwareAsync === 'function');
}

// 返回 { available, hasHardware, enrolled }。available 表示「设备至少设置了生物识别
// 或锁屏密码」——authenticateAsync 允许回退系统密码，因此只设了 PIN 的设备也能用应用锁。
export async function getBiometricAvailability() {
  const module = getLocalAuth();
  if (!module) return { available: false, hasHardware: false, enrolled: false };
  try {
    const hasHardware = typeof module.hasHardwareAsync === 'function'
      ? await module.hasHardwareAsync()
      : false;
    const enrolled = typeof module.isEnrolledAsync === 'function'
      ? await module.isEnrolledAsync()
      : false;
    // 优先用凭据等级：SECRET(=1，仅锁屏密码) 或 BIOMETRIC(=2) 都算可用。
    if (typeof module.getEnrolledLevelAsync === 'function') {
      const level = await module.getEnrolledLevelAsync();
      return { available: Number(level) > 0, hasHardware: !!hasHardware, enrolled: !!enrolled };
    }
    return { available: !!hasHardware && !!enrolled, hasHardware: !!hasHardware, enrolled: !!enrolled };
  } catch (error) {
    return { available: false, hasHardware: false, enrolled: false };
  }
}

// 触发一次生物识别验证。成功后返回 { success: true }；失败返回 { success: false, error }。
// 默认允许回退到系统密码（disableDeviceFallback: false）。
export async function authenticateBiometric(options = {}) {
  const module = getLocalAuth();
  if (!module || typeof module.authenticateAsync !== 'function') {
    return { success: false, error: 'not_available' };
  }
  try {
    const result = await module.authenticateAsync({
      promptMessage: options.promptMessage,
      cancelLabel: options.cancelLabel,
      disableDeviceFallback: false,
    });
    if (result && result.success) return { success: true };
    return { success: false, error: (result && result.error) || 'unknown' };
  } catch (error) {
    return { success: false, error: 'unknown' };
  }
}
