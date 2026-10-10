// O0.3：会话最近一份计划（update_plan 的清单）。
//
// 与消息分开的旁路键，随会话存一份最新的计划——用途是让「扁平清单」在压缩（N2）后
// 仍能恢复：N2 注入「计划最后状态」recap 段，计划不再「压缩即死」。
// 存的是调用方已归一化过的步骤数组；读侧只做最小形状兜底（不反向依赖工作区域）。

import AsyncStorage from '@react-native-async-storage/async-storage';

import { sessionPlanKey } from './sessionCore.js';

export async function getSessionPlan(sessionId) {
  const id = String(sessionId || '');
  if (!id) return [];
  try {
    const raw = await AsyncStorage.getItem(sessionPlanKey(id));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

export async function saveSessionPlan(sessionId, steps) {
  const id = String(sessionId || '');
  if (!id) return [];
  const list = Array.isArray(steps) ? steps : [];
  try {
    if (list.length === 0) {
      await AsyncStorage.removeItem(sessionPlanKey(id));
      return [];
    }
    await AsyncStorage.setItem(sessionPlanKey(id), JSON.stringify(list));
  } catch (error) {
    // 计划落盘是旁路增强：失败不影响主流程。
  }
  return list;
}

export async function clearSessionPlan(sessionId) {
  return saveSessionPlan(sessionId, []);
}
