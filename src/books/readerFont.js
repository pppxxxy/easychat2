// 阅读器字号：档位边界与增减步进的**唯一事实源**（零依赖、纯函数、Node 直测）。
//
// 为什么抽出来：这段逻辑原本内联在 books/BookReaderView.js（RN 组件）里，桌面阅读器
// 想用只能重写一份。两份边界值一旦漂移，同一本书在两端能调到的最小/最大字号不同，
// 而这是用户会直接感知的差异。抽到叶模块后手机与桌面 import 同一个函数。
//
// 语义（照抄手机原有行为，不重新设计）：
//   · 默认 17；
//   · 范围 [13, 26]；
//   · 先 Math.floor 归一化再加减，非法输入回落默认——这样即使存储里是 "17.6" 或 null，
//     按一次 A+ 也是确定的结果，而不是 NaN。

export const FONT_MIN = 13;
export const FONT_MAX = 26;
export const FONT_DEFAULT = 17;

export function changeFontSize(current, delta) {
  const base = Math.floor(Number(current)) || FONT_DEFAULT;
  const step = Number(delta) || 0;
  return Math.min(FONT_MAX, Math.max(FONT_MIN, base + step));
}

// 能否继续增减：界面据此把按钮置灰，而不是让用户按了没反应。
export function canGrowFont(current) {
  return Math.floor(Number(current)) < FONT_MAX;
}

export function canShrinkFont(current) {
  return Math.floor(Number(current)) > FONT_MIN;
}
