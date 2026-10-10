// ask_user 的宿主询问实现（纯逻辑，Alert 注入以便 Node 直测）。
//
// 用 Alert 呈现选择题：Android 最多 3 个按钮 → askUserTool 的 options 上限也是 3（+取消）。

import { normalizeAskOptions } from '../workspace/toolDefs/askUserTool.js';

export function promptUserChoice({ question, options, cancelLabel = '取消', alert } = {}) {
  const list = normalizeAskOptions(options);
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
        { text: cancelLabel, style: 'cancel', onPress: () => resolve(null) },
      ],
      { cancelable: true, onDismiss: () => resolve(null) },
    );
  });
}
