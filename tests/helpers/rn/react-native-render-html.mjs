// `react-native-render-html` 的 Node 端桩。
//
// 真实包依赖 DOM 语义与大量样式解析，Node 里跑不动也不该跑。
// 渲染测试关心的是「HTML 文本有没有送达渲染层」，所以桩把 html 原样作为 prop 与
// 子节点透出。
//
// 纪律：原样透出，不吞内容（否则「内容变空」的回归看不见）。

import React from 'react';

export function RenderHTML({ html, source, ...rest }) {
  const value = html !== undefined ? String(html) : String((source && source.html) || '');
  return React.createElement('RenderHTML', { ...rest, html: value }, null);
}

RenderHTML.displayName = 'MockRenderHTML';

// 真实包还导出这些（上层可能用来定制渲染规则）：保留最小可用形状。
export const HTMLElementModel = {
  fromCustomModel: model => ({ ...model }),
  fromNode: () => null,
};
export const HTMLContentModel = { block: 'block', textual: 'textual', none: 'none', mixed: 'mixed' };
export const defaultSystemFonts = [];
export const tagsStyles = {};
export const useInternalRenderer = () => null;

export default RenderHTML;
