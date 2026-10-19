// `react-native-markdown-display` 的 Node 端桩。
//
// 为什么必须打桩：该包 7.0.2 发布的是**未编译的原始 JSX**
// （package.json main = src/index.js，ESM、无扩展名相对导入），Node 直接报
// SyntaxError: Invalid shorthand property initializer —— 这不是我们代码的问题，
// 而是该包没有提供可被 Node 消费的产物。
//
// 桩的职责：把 markdown 文本**原样**渲染成一个 Text 宿主节点，并保留原文作为 prop，
// 这样「消息正文有没有渲染出来」仍可断言，同时按钮/交互层的测试不被 markdown 细节干扰。
//
// 纪律：只实现被用到的形状（默认导出组件）；children 原样透出，绝不吞掉内容——
// 否则「正文变空」这种回归在测试里看不见。

import React from 'react';

function Markdown({ children, style, ...rest }) {
  return React.createElement(
    'Markdown',
    { ...rest, style, text: typeof children === 'string' ? children : String(children ?? '') },
    children
  );
}

Markdown.displayName = 'MockMarkdown';

// 真实包还导出这两个（上层偶尔用到）：parser 用于自定义规则，MarkdownIt 是底层。
export const MarkdownIt = function MockMarkdownIt() {
  return { render: value => String(value ?? '') };
};

export const parser = {
  parse: (value, onParse) => {
    if (typeof onParse === 'function') onParse(null, String(value ?? ''));
    return String(value ?? '');
  },
};

export default Markdown;
