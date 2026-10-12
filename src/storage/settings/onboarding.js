// 免责声明确认与新手引导完成状态的存储。从 src/storage/settings.js 原样外提（无行为变化）。

import AsyncStorage from '@react-native-async-storage/async-storage';

const DISCLAIMER_ACK_KEY = '@easychat2_disclaimer_ack';
const ONBOARDING_DONE_KEY = '@easychat2_onboarding_done';

// 免责声明版本：条款变更时 bump——存量用户已确认的是旧版本号，
// 首启会重新弹出确认，保证新条款对全部用户生效（法律效力前提）。
//
// 3 → 4（2026-10-12）：条款**实质变更**——整段文本与分节两份手写副本已漂移
// （SECTIONS 独有「不得干扰、破坏本软件的正常运行。」「因配置错误导致的安全问题…
// 由用户自行承担。」；TEXT 独有「除聊天外」「均由你自行选择与授权」），现按
// 「对用户更严格」统一为单一来源并把 TEXT 改为派生。文字变了就必须 bump：
// 否则老用户手里确认过的仍是旧文本，新条款对他们没有效力前提。
export const DISCLAIMER_VERSION = 4;

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
