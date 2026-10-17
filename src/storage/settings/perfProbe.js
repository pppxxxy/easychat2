// 卡顿取证（perf probe）开关的持久化。裸字符串 'true'/'false'，与
// src/storage/settings/onboarding.js 同口径（那里解释了为什么这两个键**不能**套
// readJsonStatus：值不是 JSON，用 JSON.parse 去判形状是把语义判据建立在巧合上）。
//
// 为什么这个开关必须落盘：探针的用途是「开启 → 复现 → 看哪一段超阈值」。真机上从
// 开启到复现之间几乎必然要**重启 App**（切到别的应用、被系统回收、甚至崩一次），
// 只存在内存里的开关会在那一刻丢掉，用户复现完回来发现一条样本都没有。
//
// 读失败的方向是 **fail-closed（按关闭处理）**，与免责声明那条 fail-secure 相反：
// 探针开着只是多记几条本地诊断，关着不会丢任何用户数据；而「读不出就当开着」会让
// 一个坏值永久打开埋点。但**必须留痕**——否则「读失败」与「用户从没开过」同形。
import AsyncStorage from '@react-native-async-storage/async-storage';

import { recordDiagnostic } from '../diagnostics.js';

export const PERF_PROBE_KEY = '@easychat2_perf_probe';

// 判据只有一处：'true' 才算开。其余（null / 'false' / '1' / 'yes' / 任意脏值）一律关。
export function normalizePerfProbeFlag(raw) {
  return raw === 'true';
}

export async function getPerfProbeEnabled() {
  let raw = null;
  try {
    raw = await AsyncStorage.getItem(PERF_PROBE_KEY);
  } catch (error) {
    recordDiagnostic(
      'storage',
      new Error('卡顿取证开关读取失败（读不出，按「关闭」处理）'),
      `${PERF_PROBE_KEY}：${String((error && error.message) || '')}`
    );
    return false;
  }
  return normalizePerfProbeFlag(raw);
}

export async function savePerfProbeEnabled(value) {
  const enabled = value === true;
  await AsyncStorage.setItem(PERF_PROBE_KEY, enabled ? 'true' : 'false');
  return enabled;
}
