// 工具审批的完整流转：规则求值 →（未命中时）弹框 → 记录选择 → 布尔裁决。
//
// 为什么从 toolApproval.js 拆出来：那里是纯 UI（弹框 + 文案 + 生命周期），
// 顶部零存储依赖、Node 直测不受影响；这里牵规则引擎与 AsyncStorage，
// 是「链」不是「面」——分层后各测各的。
//
// 规则读失败的处理原则：**宁问不猜**。读不到规则 = 当没有规则 → 照常弹框问人，
// 绝不把「存储异常」变成「静默放行」。

import { evaluatePermissionRules, makePermissionRule } from '../agent/permissions.js';
import { permissionBroker } from '../agent/permission/broker.js';
import {
  addPermissionRule,
  addSessionPermissionRule,
  getEffectivePermissionRules,
} from '../storage/settings/workspacePermissions.js';
import {
  APPROVAL_ALWAYS,
  APPROVAL_ONCE,
  APPROVAL_SESSION,
  requestToolApproval,
} from './toolApproval.js';

// 前台默认应答方：Alert 弹框。后台运行 / 测试可经 options.handler 换成别的应答方式
//（自动拒绝、通知栏、面板）——broker 只认「谁能给出决定」，不关心问法。
function defaultApprovalHandler(request) {
  return requestToolApproval({
    name: request.toolName,
    args: request.args,
    t: request.t,
    signal: request.signal,
    showAlert: request.showAlert,
    askOnly: request.askOnly,
  });
}

let approvalRequestSeq = 0;
function nextApprovalRequestId() {
  approvalRequestSeq += 1;
  return `approval-${approvalRequestSeq}`;
}

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
  // 审批 broker 与应答方：默认走应用级 broker + Alert 弹框；后台运行可传自己的
  // handler（例如无人值守时一律拒绝），无需改动本函数。
  broker = permissionBroker,
  handler = null,
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

  // ask 档：显式「必须先问」。只给「拒绝 / 允许这一次」——**批准不记规则**，
  // 否则一次点击就把「必须先问」永久解除，这个档就白加了。
  const askOnly = verdict === 'ask';
  // 走 broker（Z 系 #3）：生命周期与「谁来答」解耦；ask 档随请求带下去。
  const decision = await broker.requestPermission(
    { requestId: nextApprovalRequestId(), toolName: name, args, t, signal, showAlert, askOnly },
    { signal, handler: handler || defaultApprovalHandler }
  );
  const value = typeof decision === 'string'
    ? decision
    : String((decision && decision.decision) || '');
  if (value === APPROVAL_ONCE) return true;
  if (askOnly) return false; // ask 档下其余返回值（含异常/未知选项）一律按拒绝
  if (value === APPROVAL_SESSION) {
    try {
      addSessionPermissionRule(makePermissionRule({ tool: name, args, scope: 'session' }));
    } catch (error) {}
    return true;
  }
  if (value === APPROVAL_ALWAYS) {
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
