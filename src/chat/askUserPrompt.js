// ask_user 的宿主询问实现（纯逻辑，Alert 注入以便 Node 直测）。
//
// 用 Alert 呈现选择题：Android 最多 3 个按钮 → askUserTool 的 options 上限也是 3（+取消）。

import { normalizeAskOptions } from '../workspace/toolDefs/askUserTool.js';
import { tActive } from '../i18n/index.js';

export function promptUserChoice({ question, options, cancelLabel, alert } = {}) {
  const list = normalizeAskOptions(options);
  // 取消按钮文案：调用方传 i18n 文案；缺省走 i18n 单例的默认语言（不再硬编码中文）。
  const cancel = String(cancelLabel || '').trim() || tActive('common.cancel');
  return new Promise(resolve => {
    if (typeof alert !== 'function') {
      resolve(null);
      return;
    }
    alert(
      String(question || ''),
      '',
      [
        ...list.map(option => ({ text: option, onPress: () => resolve(option) })),
        { text: cancel, style: 'cancel', onPress: () => resolve(null) },
      ],
      { cancelable: true, onDismiss: () => resolve(null) },
    );
  });
}
