// 工具域 schema 层共用的「任意值 → 可读短串」渲染（**唯一实现**）。
//
// 为什么单独一个文件：appSettingsSchema / musicToolSchema / reminderSchema 三处
// 都需要把模型传来的任意值渲染成可读短串（错误消息里用），原本各写一份近乎相同的
// describeValue / describeMusicValue / describeReminderValue——三份必然漂移
//（例如某一处漏了 undefined 分支）。口径统一到这里，各域按自己的历史名字 re-export，
// 公共 API 不变。
//
// 零依赖、纯函数：Node 可直测，被三个纯层 schema 共享。

/**
 * 把任意值渲染成可读短串（错误消息里用，不出现 `[object Object]`）。
 *
 * 字符串加「」便于与裸数字区分；null / undefined 显式标注（`String(undefined)`
 * 会得到字面量 "undefined"，对用户无意义）。
 */
export function describeValue(value) {
  if (typeof value === 'string') return `「${value}」`;
  if (value === null) return 'null';
  if (value === undefined) return '（未给）';
  if (Array.isArray(value)) return '数组';
  if (typeof value === 'object') return '对象';
  return String(value);
}