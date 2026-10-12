// O0.3：会话最近一份计划（update_plan 的清单）。
//
// 与消息分开的旁路键，随会话存一份最新的计划——用途是让「扁平清单」在压缩（N2）后
// 仍能恢复：N2 注入「计划最后状态」recap 段，计划不再「压缩即死」。
// 存的是调用方已归一化过的步骤数组；读侧只做最小形状兜底（不反向依赖工作区域）。

import AsyncStorage from '@react-native-async-storage/async-storage';

import { tActive } from '../i18n/index.js';
import { recordDiagnostic } from './diagnostics.js';
import { sessionPlanKey } from './sessionCore.js';

// 读侧三态缺失的留痕。**定性已下调**：写侧两个 onPlan 都来自 planTool.js，而工具
// 文档明确「plan 传整个清单的最新版本（不是增量）」⇒ 写是全量覆盖语义，不存在
// 「读-改-写」链，所以这里**只留痕、不加写守卫**（加了只会把行为矩阵撑大而没有实际收益）。
// 留痕的目的只有一个：让「读不出」与「确实没有计划」在诊断里可区分——本函数只有
// 「清单」与「空数组」两种返回，调用方（workspace/screen/ChatPanel.js 的 recap 注入）
// 无法自己分辨这两者。诊断文案走 i18n key（写法同 io.js:187 的
// error.storage.readCorruptBackedUp）：recordDiagnostic 会先跑 maskSecrets
//（diagnostics.js 的 mask），片段可能被替换甚至清空，所以「发生了什么」必须在 message 本身。
// 包一层函数而不是模块级常量：tActive 要在**失败发生时**取值（语言可切换），
// 同时模块级硬编码文案也被 lint 规则 local-i18n/no-hardcoded-chinese-text 禁止。
function planReadFailedMessage() {
  return tActive('error.storage.sessionPlanReadFailed');
}

export async function getSessionPlan(sessionId) {
  const id = String(sessionId || '');
  if (!id) return [];
  const key = sessionPlanKey(id);
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    // 合法 JSON 但不是清单：与「读不出」同形，同样留痕
    recordDiagnostic('storage', new Error(planReadFailedMessage()), `getSessionPlan：${key}`);
    return [];
  } catch (error) {
    recordDiagnostic('storage', new Error(planReadFailedMessage()), `getSessionPlan：${key}`);
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

// 这里曾有一个 clearSessionPlan(id) = saveSessionPlan(id, [])，全仓零调用（死导出）。
// 会话删除改走 mutations.js 的 sessionScopedKeys（把计划键并进同一次 multiRemove），
// 于是它连「唯一的潜在调用点」也没了——删掉，而不是留着等下一个调用方以为它在生效。
