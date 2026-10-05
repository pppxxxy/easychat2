// 工具执行前的人工确认（目前只有 run_shell 会走到这里）。
//
// 为什么单独一个模块：这段逻辑要能单测。Alert 是 RN 的东西，Node 里没有，
// 所以弹框函数由调用方注入（默认为 RN 的 Alert.alert），纯文案构造与生命周期
// 都在这里，测试用一个假的弹框就能把「拒绝就返回 false」「中止立刻结算」钉死。
//
// 三个必须守住的点：
// 1. **用户拒绝时绝不执行**：返回 false，由 registry 直接回错误结果；
// 2. **不能留悬挂的 Promise**：用户点了「停止生成」时立即按拒绝结算，
//    否则整个 agent 循环会卡在一个永远等不到答案的弹框上；
// 3. **弹框里要显示完整命令原文**：只说「允许执行命令吗？」等于让用户盲签。
//    命令可能很长，因此正文不截断（这是唯一一处刻意不做长度限制的文案）。

export const APPROVAL_DENIED = 'approval-denied';

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
export function describeToolApproval({ name, args, t } = {}) {
  const translate = typeof t === 'function' ? t : key => key;
  const values = args && typeof args === 'object' ? args : {};
  const command = String(values.command === undefined || values.command === null ? '' : values.command);
  // run_shell 之外的需确认工具（GitHub 写操作等）没有 command 字段：把参数
  // 摘要亮出来——「允许执行工具吗」等于让用户盲签，看不到参数就不算知情同意。
  let argsSummary = '';
  if (!command && Object.keys(values).length > 0) {
    try {
      argsSummary = JSON.stringify(values, null, 2);
    } catch (error) {
      argsSummary = '';
    }
    if (argsSummary.length > 600) argsSummary = `${argsSummary.slice(0, 600)}\n…（参数过长已截断）`;
  }
  return {
    title: translate('chat.tool.approval.title', { name }),
    body: command
      ? translate('chat.tool.approval.body', { command })
      : (argsSummary
        ? translate('chat.tool.approval.bodyArgs', { args: argsSummary })
        : translate('chat.tool.approval.bodyEmpty')),
    deny: translate('chat.tool.approval.deny'),
    allow: translate('chat.tool.approval.allow'),
  };
}

// 请求确认。showAlert 可注入（默认 RN Alert.alert）；signal 中止时立即结算为拒绝。
export function requestToolApproval({
  name,
  args,
  t,
  signal = null,
  showAlert = null,
} = {}) {
  const alert = showAlert || getAlert();
  const copy = describeToolApproval({ name, args, t });

  // 没有弹框能力 = 问不到用户 = 拒绝（与 registry 的「无 confirm 即拒绝」同一条原则）。
  if (!alert || typeof alert.alert !== 'function') return Promise.resolve(false);
  if (signal && signal.aborted) return Promise.resolve(false);

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
      onAbort = () => settle(false);
      signal.addEventListener('abort', onAbort);
    }

    alert.alert(
      copy.title,
      copy.body,
      [
        { text: copy.deny, style: 'cancel', onPress: () => settle(false) },
        { text: copy.allow, style: 'destructive', onPress: () => settle(true) },
      ],
      // 点弹框外部关掉 / 返回键：一律按拒绝处理（cancelable 才需要 onDismiss）。
      { cancelable: true, onDismiss: () => settle(false) },
    );
  });
}
