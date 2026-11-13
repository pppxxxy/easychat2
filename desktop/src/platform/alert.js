// Alert 适配：应用内模态（design.md「适配层契约 6」）。
//
// 为什么不是原生 dialog.showMessageBox：共享层调用 Alert.alert 80 余次，按钮文案来自
// 词条、回调里还会继续 await；应用内模态能保持「同步返回 + 回调」的原有节奏，
// 也能统一主题与词条。这里只实现队列与状态机；渲染由 desktop/src/ui 的 AlertHost 订阅。
let currentAlert = null;
const queue = [];
const listeners = new Set();

function emit() {
  for (const listener of [...listeners]) {
    try {
      listener(currentAlert);
    } catch (error) {}
  }
}

function normalizeButtons(buttons) {
  if (Array.isArray(buttons) && buttons.length > 0) {
    return buttons.map(button => ({
      text: String((button && button.text) || 'OK'),
      style: (button && button.style) || 'default',
      onPress: button && typeof button.onPress === 'function' ? button.onPress : null,
    }));
  }
  return [{ text: 'OK', style: 'default', onPress: null }];
}

function advance() {
  currentAlert = queue.length > 0 ? queue.shift() : null;
  emit();
}

export function showAlert(title, message, buttons) {
  queue.push({
    title: String(title ?? ''),
    message: message == null ? '' : String(message),
    buttons: normalizeButtons(buttons),
  });
  if (!currentAlert) advance();
}

// UI 层点击某个按钮时调用：先切到下一张（保持「弹窗关闭 -> 回调」的顺序），再执行回调。
export function resolveAlert(buttonIndex) {
  const alert = currentAlert;
  if (!alert) return;
  const button = alert.buttons[buttonIndex];
  advance();
  if (button && typeof button.onPress === 'function') {
    try {
      button.onPress();
    } catch (error) {}
  }
}

export function subscribeAlert(listener) {
  listeners.add(listener);
  listener(currentAlert);
  return () => listeners.delete(listener);
}

export function getCurrentAlert() {
  return currentAlert;
}

export const Alert = Object.freeze({
  alert: showAlert,
  prompt: () => {
    // RN 的 prompt 仅 iOS 有；桌面暂不支持，用 alert 形态给出说明（不静默吞掉调用）。
    showAlert('Not supported', 'Alert.prompt is not available on desktop.');
  },
});
