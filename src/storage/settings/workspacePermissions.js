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
import { tActive } from '../../i18n/index.js';
import { backupCorruptValue, createMutationQueue, readJsonStatus } from '../io.js';

export const PERMISSIONS_KEY = '@easychat2_workspace_permissions';

const permissionsMutation = createMutationQueue();

// 会话级规则（内存，不落盘）：模块单例即「本次运行」的生命周期。
let sessionRules = [];

// 读规则并**保留读取状态**。读路径对外行为不变（损坏时仍给空规则表，弹框照常能问），
// status 只交给写路径判定「这次能不能写回」。
// 参考 src/storage/worldMap.js:19-27（getWorldMapStatus）。
async function readStore() {
  const stored = await readJsonStatus(PERMISSIONS_KEY);
  if (stored.status === 'ok') {
    const source = stored.value && typeof stored.value === 'object' && !Array.isArray(stored.value)
      ? stored.value
      : {};
    return { status: 'ok', rules: normalizePermissionRules(source.rules) };
  }
  if (stored.status === 'corrupt') {
    await backupCorruptValue(PERMISSIONS_KEY);
    return { status: 'corrupt', rules: [] };
  }
  return { status: 'missing', rules: [] };
}

// 写路径守卫（变体①：拒绝写回 / 抛错）。
// 参考 src/storage/worldMap.js:34-40（updateWorldMap）与 src/storage/cardForge.js:182-186。
//
// 为什么必须守卫：本域的写入全是**读-改-写整表覆盖**（add/remove/clear 都写
// `{ rules: ... }`）。读失败时「当前规则」是空表，于是
//   - addPermissionRule 写回「只剩刚点的那一条」；
//   - removePermissionRule 写回「除了要删的那条，其余全没」；
// 用户点一次「永远允许」，此前记住的 deny/allow 全部消失。清空同样拒绝：
// 损坏的原始字节是唯一副本，且损坏时规则本来就不参与求值（getPermissionRules 给空表），
// 所以拒绝不会削弱「授权可撤销」这条保证，只会阻止不可逆的覆盖。
function requireRulesForMutation(current) {
  if (current.status === 'corrupt') {
    throw new Error(tActive('error.storage.permissionsReadFailed'));
  }
  return current.rules;
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
    const current = requireRulesForMutation(await readStore());
    const exists = current.some(item => (
      item.effect === value.effect && item.tool === value.tool && item.match === value.match
    ));
    if (!exists) await writeStore({ rules: [...current, value] });
    return value;
  });
}

// 删除：按 effect+tool+match 定位（不用索引：归一化去重后行号不可靠）。
export function removePermissionRule(rule) {
  const normalized = normalizePermissionRule(rule);
  if (!normalized) return Promise.resolve(false);
  return permissionsMutation.enqueue(async () => {
    const current = requireRulesForMutation(await readStore());
    const next = current.filter(item => !(
      item.effect === normalized.effect && item.tool === normalized.tool && item.match === normalized.match
    ));
    if (next.length === current.length) return false;
    await writeStore({ rules: next });
    return true;
  });
}

// 清空「已记住的授权」：永久与本次会话一起清（撤销入口——授权必须可撤销，
// 否则「永远允许」点错一次就成了没法回头的坑）。
export function clearPermissionRules() {
  sessionRules = [];
  return permissionsMutation.enqueue(async () => {
    // 同样是整表覆盖，同样走守卫：损坏时拒绝，由用户先处理损坏数据
    //（原始值已在 readStore 里备份）。理由见 requireRulesForMutation 的注释。
    requireRulesForMutation(await readStore());
    await writeStore({ rules: [] });
    return true;
  });
}

export async function getPermissionRuleCount() {
  const current = await readStore();
  // 读失败不再谎报「0 条」：损坏时额外给出 corrupt 标记，调用方能区分
  // 「确实没有规则」与「规则读不出来」。always/session 两个既有字段保持不变。
  return {
    always: current.rules.length,
    session: sessionRules.length,
    corrupt: current.status === 'corrupt',
  };
}
