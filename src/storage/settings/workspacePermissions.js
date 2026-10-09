// 权限规则存储域（spec 2026-10-09-agent-extensibility T3）。
//
// 键 `@easychat2_workspace_permissions`，形状 `{ rules: [...] }`（对象包一层，
// 将来加版本/元数据字段不用动根结构；规则本体的归一化与匹配在 agent/permissions.js）。
//
// 两种作用域（scope）：
// - 'always'：落盘，跨重启记忆（弹框「永远允许」按钮）；
// - 'session'：只在模块内存里，进程活着有效（弹框「本次会话允许」按钮）——
//   **刻意不落盘**：用户说的是「这次先这样」，重启就该忘，防「以为只是一次」变永久。
//
// 求值前用 getEffectivePermissionRules() 合并两类（顺序无关：deny 恒优先）。

import AsyncStorage from '@react-native-async-storage/async-storage';

import { normalizePermissionRule, normalizePermissionRules } from '../../agent/permissions.js';
import { backupCorruptValue, createMutationQueue, readJsonStatus } from '../io.js';

export const PERMISSIONS_KEY = '@easychat2_workspace_permissions';

const permissionsMutation = createMutationQueue();

// 会话级规则（内存，不落盘）：模块单例即「本次运行」的生命周期。
let sessionRules = [];

async function readStore() {
  const stored = await readJsonStatus(PERMISSIONS_KEY);
  if (stored.status === 'ok') {
    const source = stored.value && typeof stored.value === 'object' && !Array.isArray(stored.value)
      ? stored.value
      : {};
    return { rules: normalizePermissionRules(source.rules) };
  }
  if (stored.status === 'corrupt') await backupCorruptValue(PERMISSIONS_KEY);
  return { rules: [] };
}

async function writeStore(next) {
  await AsyncStorage.setItem(PERMISSIONS_KEY, JSON.stringify({ rules: normalizePermissionRules(next.rules) }));
}

export async function getPermissionRules() {
  return (await readStore()).rules;
}

// 会话 + 盘上合并（弹框求值前调用）。会话在前只是调试观感，不改变求值结果。
export async function getEffectivePermissionRules() {
  return [...sessionRules, ...(await getPermissionRules())];
}

export function getSessionPermissionRules() {
  return [...sessionRules];
}

export function clearSessionPermissionRules() {
  sessionRules = [];
}

export function addSessionPermissionRule(rule) {
  const normalized = normalizePermissionRule(rule);
  if (!normalized) return null;
  const value = { ...normalized, scope: 'session' };
  const exists = sessionRules.some(item => (
    item.effect === value.effect && item.tool === value.tool && item.match === value.match
  ));
  if (!exists) sessionRules = [...sessionRules, value];
  return value;
}

// 落盘加一条（「永远允许」）：同 effect+tool+match 已存在则不重复写。
export function addPermissionRule(rule) {
  const normalized = normalizePermissionRule(rule);
  if (!normalized) return Promise.resolve(null);
  const value = { ...normalized, scope: 'always' };
  return permissionsMutation.enqueue(async () => {
    const current = await readStore();
    const exists = current.rules.some(item => (
      item.effect === value.effect && item.tool === value.tool && item.match === value.match
    ));
    if (!exists) await writeStore({ rules: [...current.rules, value] });
    return value;
  });
}

// 删除：按 effect+tool+match 定位（不用索引：归一化去重后行号不可靠）。
export function removePermissionRule(rule) {
  const normalized = normalizePermissionRule(rule);
  if (!normalized) return Promise.resolve(false);
  return permissionsMutation.enqueue(async () => {
    const current = await readStore();
    const next = current.rules.filter(item => !(
      item.effect === normalized.effect && item.tool === normalized.tool && item.match === normalized.match
    ));
    if (next.length === current.rules.length) return false;
    await writeStore({ rules: next });
    return true;
  });
}

// 清空「已记住的授权」：永久与本次会话一起清（撤销入口——授权必须可撤销，
// 否则「永远允许」点错一次就成了没法回头的坑）。
export function clearPermissionRules() {
  sessionRules = [];
  return permissionsMutation.enqueue(async () => {
    await writeStore({ rules: [] });
    return true;
  });
}

export async function getPermissionRuleCount() {
  return { always: (await getPermissionRules()).length, session: sessionRules.length };
}
