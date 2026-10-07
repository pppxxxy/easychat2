// 免责声明确认与新手引导完成状态的存储。从 src/storage/settings.js 原样外提（无行为变化）。

import AsyncStorage from '@react-native-async-storage/async-storage';

const DISCLAIMER_ACK_KEY = '@easychat2_disclaimer_ack';
const ONBOARDING_DONE_KEY = '@easychat2_onboarding_done';

// 免责声明版本：条款变更时 bump——存量用户已确认的是旧版本号，
// 首启会重新弹出确认，保证新条款对全部用户生效（法律效力前提）。
export const DISCLAIMER_VERSION = 3;

export async function isDisclaimerAcknowledged() {
  const raw = await AsyncStorage.getItem(DISCLAIMER_ACK_KEY);
  return raw === String(DISCLAIMER_VERSION);
}

export async function acknowledgeDisclaimer() {
  await AsyncStorage.setItem(DISCLAIMER_ACK_KEY, String(DISCLAIMER_VERSION));
  return true;
}

export async function isOnboardingDone() {
  const raw = await AsyncStorage.getItem(ONBOARDING_DONE_KEY);
  return raw === 'true';
}

export async function completeOnboarding() {
  await AsyncStorage.setItem(ONBOARDING_DONE_KEY, 'true');
  return true;
}
