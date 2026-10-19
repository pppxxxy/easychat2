// `react-native-webview` 与 `react-native-render-html` 的 Node 端桩。
//
// 两者都是原生/重 UI 包：WebView 需要真实 WebView 引擎，render-html 依赖 DOM 语义。
// 渲染测试只关心「HTML 内容有没有被交给渲染层」，所以桩把原文投影成宿主节点的 prop。
//
// 纪律：children/source 原样透出，绝不吞内容——否则「内容变空」这类回归在测试里看不见。

import React from 'react';

export function WebView({ source, ...rest }) {
  const html = (source && (source.html || source.uri)) || '';
  return React.createElement('WebView', { ...rest, html }, null);
}

WebView.displayName = 'MockWebView';

export default WebView;
