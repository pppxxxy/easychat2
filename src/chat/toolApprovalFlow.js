// 工具审批的完整流转：规则求值 →（未命中时）弹框 → 记录选择 → 布尔裁决。
//
// 为什么从 toolApproval.js 拆出来：那里是纯 UI（弹框 + 文案 + 生命周期），
// 顶部零存储依赖、Node 直测不受影响；这里牵规则引擎与 AsyncStorage，
// 是「链」不是「面」——分层后各测各的。
//
// 规则读失败的处理原则：**宁问不猜**。读不到规则 = 当没有规则 → 照常弹框问人，
// 绝不把「存储异常」变成「静默放行」。

import { evaluatePermissionRules, makePermissionRule } from '../agent/permissions.js';
import {
  addPermissionRule,
  addSessionPermissionRule,
  getEffectivePermissionRules,
} from '../storage/settings/workspacePermissions.js';
import {
  APPROVAL_ALWAYS,
  APPROVAL_SESSION,
  requestToolApproval,
} from './toolApproval.js';

// registry 的 onToolApproval 钩子入口：返回 boolean（true = 执行）。
// 两处调用点（聊天页 useChatSend / 工作区 ChatPanel）共用，规则也跨页共享——
// 用户在任一处说了「永远允许 npm install」，另一处同样生效（同一个工具、同一份授权）。
export async function approveToolCall({
  name,
  args,
  t,
  signal = null,
  showAlert = null,
  // 本次调用的附加规则（工作区 hooks.json 的 before_shell 预置禁令翻译而来）。
  // 与存储规则合并求值：deny 优先由 evaluate 保证，与来源和顺序无关。
  extraRules = [],
} = {}) {
  const injected = Array.isArray(extraRules) ? extraRules : [];
  let verdict = null;
  try {
    const rules = await getEffectivePermissionRules();
    verdict = evaluatePermissionRules([...injected, ...rules], { tool: name, args });
  } catch (error) {
    // 存储读失败 → 按「没有存储规则」处理，但**注入的钩子规则仍要参与求值**：
    // 预置禁令是用户写在工作区文件里的，不该因为存储异常而失效。
    verdict = evaluatePermissionRules(injected, { tool: name, args });
  }
  if (verdict === 'deny') return false;
  if (verdict === 'allow') return true;

  const decision = await requestToolApproval({ name, args, t, signal, showAlert });
  if (decision === APPROVAL_SESSION) {
    try {
      addSessionPermissionRule(makePermissionRule({ tool: name, args, scope: 'session' }));
    } catch (error) {}
    return true;
  }
  if (decision === APPROVAL_ALWAYS) {
    // 落盘失败也按允许结算：用户已经同意执行这一次，规则没记住只是下次再问，
    // 但绝不能因为「存储写失败」把用户已经批准的操作变成拒绝。
    try {
      await addPermissionRule(makePermissionRule({ tool: name, args, scope: 'always' }));
    } catch (error) {}
    return true;
  }
  // 'deny' 与任何未知返回值（弹框异常、未来新增选项没接线）一律按拒绝结算。
  return false;
}
