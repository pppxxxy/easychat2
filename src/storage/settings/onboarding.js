// 免责声明确认与新手引导完成状态的存储。从 src/storage/settings.js 原样外提（无行为变化）。

import AsyncStorage from '@react-native-async-storage/async-storage';

import { recordDiagnostic } from '../diagnostics.js';

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

// 这两个键存的是**裸字符串**（'4' / 'true'），不是 JSON —— 所以**不能**套 readJsonStatus
//（那会对值 JSON.parse，'4' 与 'true' 虽然恰好都能 parse，但语义上这里是「原始串比较」，
//  一旦将来换成 'yes' 这种值就会被判成 corrupt）。改用 try/catch + recordDiagnostic。
//
// 为什么必须包 try/catch：原先两处都是裸 getItem，getItem 抛错（如 CursorWindow 2MB 读上限）
// 时返回的是 **rejected promise**。调用点的 catch 会把「读不出」当成「没确认过」
//（对免责声明是 fail-secure 方向，可接受），但**调用方并未被告知这是读失败**——
// 「新用户」与「存储故障」无法区分，诊断信息直接丢失。
// 这与 src/storage/sessionCore.js 注释里记录的那批「裸 getItem、未被 19 处 readJson 路径
// 修复覆盖」的遗漏同族（本文件是第三、四例）。
// 诊断文本必须**自足**：message 本身就说清「哪个状态读不出、按什么口径处理」，
// 键名放在 context 里做补充 —— recordDiagnostic 会先跑 maskSecrets，context 有被替换的可能，
// 「读失败」这件事不能只写在 context 里（口径同 src/storage/characters/index.js:439-447）。
export async function isDisclaimerAcknowledged() {
  let raw = null;
  try {
    raw = await AsyncStorage.getItem(DISCLAIMER_ACK_KEY);
  } catch (error) {
    recordDiagnostic(
      'storage',
      new Error('免责声明确认状态读取失败（读不出，按「未确认」从严处理）'),
      `${DISCLAIMER_ACK_KEY}：${String((error && error.message) || '')}`
    );
    return false;
  }
  return raw === String(DISCLAIMER_VERSION);
}

export async function acknowledgeDisclaimer() {
  await AsyncStorage.setItem(DISCLAIMER_ACK_KEY, String(DISCLAIMER_VERSION));
  return true;
}

export async function isOnboardingDone() {
  let raw = null;
  try {
    raw = await AsyncStorage.getItem(ONBOARDING_DONE_KEY);
  } catch (error) {
    recordDiagnostic(
      'storage',
      new Error('新手引导完成状态读取失败（读不出，按「未完成」处理）'),
      `${ONBOARDING_DONE_KEY}：${String((error && error.message) || '')}`
    );
    return false;
  }
  return raw === 'true';
}

export async function completeOnboarding() {
  await AsyncStorage.setItem(ONBOARDING_DONE_KEY, 'true');
  return true;
}
