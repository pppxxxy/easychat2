// 工具执行前的人工确认（run_shell / run_python / GitHub 写操作等会走到这里）。
//
// 为什么单独一个模块：这段逻辑要能单测。Alert 是 RN 的东西，Node 里没有，
// 所以弹框函数由调用方注入（默认为 RN 的 Alert.alert），纯文案构造与生命周期
// 都在这里，测试用一个假的弹框就能把「拒绝就返回 deny」「中止立刻结算」钉死。
//
// 四个必须守住的点：
// 1. **用户拒绝时绝不执行**：返回 'deny'，由上层直接回错误结果；
// 2. **不能留悬挂的 Promise**：用户点了「停止生成」时立即按拒绝结算，
//    否则整个 agent 循环会卡在一个永远等不到答案的弹框上；
// 3. **弹框里要显示完整命令原文**：只说「允许执行命令吗？」等于让用户盲签。
//    命令可能很长，因此正文不截断（这是唯一一处刻意不做长度限制的文案）；
// 4. **三选项必须语义无歧义**（T3 权限规则）：
//    - 「拒绝」→ 'deny'（这次不执行）；
//    - 「本次会话允许」→ 'session'（这条命令本会话内不再问；规则只覆盖**这条命令**
//      的原文前缀，不是"放行这个工具"，授权放大极其有限）；
//    - 「永远允许」→ 'always'（同上，但跨重启记住，可在工作区设置里清除）。
//    三选一是 Android 原生 Alert 的硬上限（超过 3 个按钮会被系统丢掉多余项），
//    所以没有单独的「允许一次」：它的语义被「本次会话允许」覆盖（同命令重复调用
//    才会命中规则，跑一次就等于允许一次）。

export const APPROVAL_DENIED = 'approval-denied';
export const APPROVAL_SESSION = 'session';
export const APPROVAL_ALWAYS = 'always';
// ask 档专用：只允许这一次，**不记规则**（「必须先问」不能被一次点击永久解除）。
export const APPROVAL_ONCE = 'once';

let rnAlert;
let rnAlertLoaded = false;

function getAlert() {
  if (!rnAlertLoaded) {
    rnAlertLoaded = true;
    try {
      rnAlert = require('react-native').Alert;
    } catch (error) {
      rnAlert = null;
    }
  }
  return rnAlert;
}

// 文案构造（纯函数，便于单测）：模型给的参数可能缺字段，这里一律兜底成可读文本。
export function describeToolApproval({ name, args, t, askOnly = false } = {}) {
  const translate = typeof t === 'function' ? t : key => key;
  const values = args && typeof args === 'object' ? args : {};
  const command = String(values.command === undefined || values.command === null ? '' : values.command);
  // run_python 的参数是 code：**原样显示，不做 JSON 转义**——用户要审的就是这段代码，
  // 转义成 "\n" 反而看不清（与命令原文同一条原则：看不到原文就不算知情同意）。
  const code = String(values.code === undefined || values.code === null ? '' : values.code);
  // 其余需确认工具（GitHub 写操作等）没有 command/code 字段：把参数摘要亮出来——
  // 「允许执行工具吗」等于让用户盲签。
  let argsSummary = '';
  if (!command && !code && Object.keys(values).length > 0) {
    try {
      argsSummary = JSON.stringify(values, null, 2);
    } catch (error) {
      argsSummary = '';
    }
    if (argsSummary.length > 600) argsSummary = `${argsSummary.slice(0, 600)}\n…（参数过长已截断）`;
  }
  let body;
  if (command) {
    body = translate('chat.tool.approval.body', { command });
  } else if (code) {
    body = translate('chat.tool.approval.bodyCode', { code });
  } else if (argsSummary) {
    body = translate('chat.tool.approval.bodyArgs', { args: argsSummary });
  } else {
    body = translate('chat.tool.approval.bodyEmpty');
  }
  return {
    title: translate('chat.tool.approval.title', { name }),
    // ask 档：在正文前说明「为什么这里没有『永远允许』」，否则用户会以为界面坏了。
    body: askOnly ? `${translate('chat.tool.approval.askRuleNote')}\n\n${body}` : body,
    deny: translate('chat.tool.approval.deny'),
    allow: translate('chat.tool.approval.allow'),
    session: translate('chat.tool.approval.session'),
    always: translate('chat.tool.approval.always'),
    once: translate('chat.tool.approval.once'),
  };
}

// 请求确认。showAlert 可注入（默认 RN Alert.alert）；signal 中止时立即结算为拒绝。
// askOnly=true：这次调用被一条**显式 ask 规则**覆盖（见 agent/permissions.js），
// 因此只给「拒绝 / 允许这一次」两个按钮——不提供「本次会话允许 / 永远允许」，
// 因为那会把「必须先问」变成「问过一次就不用问了」。文案里说明原因与改法。
// 返回 APPROVAL_DENIED / APPROVAL_ONCE（askOnly）或 APPROVAL_SESSION / APPROVAL_ALWAYS。
export function requestToolApproval({
  name,
  args,
  t,
  signal = null,
  showAlert = null,
  askOnly = false,
} = {}) {
  const alert = showAlert || getAlert();
  const copy = describeToolApproval({ name, args, t, askOnly });

  // 没有弹框能力 = 问不到用户 = 拒绝（与 registry 的「无 confirm 即拒绝」同一条原则）。
  if (!alert || typeof alert.alert !== 'function') return Promise.resolve(APPROVAL_DENIED);
  if (signal && signal.aborted) return Promise.resolve(APPROVAL_DENIED);

  return new Promise(resolve => {
    let settled = false;
    const settle = value => {
      if (settled) return;
      settled = true;
      if (onAbort && signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort);
      }
      resolve(value);
    };
    // 先声明再赋值：settle 里要用到它，而它在 addEventListener 之后才有值。
    let onAbort = null;
    if (signal && typeof signal.addEventListener === 'function') {
      onAbort = () => settle(APPROVAL_DENIED);
      signal.addEventListener('abort', onAbort);
    }

    // 按钮顺序即 Android 对话框的显示顺序；'cancel' 位置留给「拒绝」——
    // 系统把 cancel 按钮放在最外/返回键位置，误触的代价最低。
    const buttons = askOnly
      ? [
        { text: copy.deny, style: 'cancel', onPress: () => settle(APPROVAL_DENIED) },
        { text: copy.once, onPress: () => settle(APPROVAL_ONCE) },
      ]
      : [
        { text: copy.deny, style: 'cancel', onPress: () => settle(APPROVAL_DENIED) },
        { text: copy.session, onPress: () => settle(APPROVAL_SESSION) },
        { text: copy.always, style: 'destructive', onPress: () => settle(APPROVAL_ALWAYS) },
      ];
    alert.alert(
      copy.title,
      copy.body,
      buttons,
      // 点弹框外部关掉 / 返回键：一律按拒绝处理（cancelable 才需要 onDismiss）。
      { cancelable: true, onDismiss: () => settle(APPROVAL_DENIED) },
    );
  });
}
