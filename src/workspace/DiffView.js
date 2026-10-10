// H2：diff 可视化（轻量 WebView，非 Monaco 完整版）。
//
// 为什么不 Monaco：5MB+ 的 assets 打包 + 编辑器语义（IntelliSense/多标签）在本 App
// 定位里用不上；这里要的只是「改动看得清」——行级着色 + 行号 + 增删统计足够。
// WebView 只管渲染一个静态 HTML（无 JS 桥、无网络）——XSS 面在 buildDiffHtml
// 生成时全部转义收口；react-native-webview 按可选能力惰性取（与 RichHtmlMessage
// 同款），缺失时给一行文字提示而不是崩。
//
// 两种输入形态（与 lineDiff 的两条通路对应）：
//   unified：远程 unified diff 文本（E5 commit 详情）；
//   oldText/newText：本地 vs 远程内容（文件面板「与远程比对」）。

import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useTheme } from '../theme/ThemeContext.js';
import { useTranslation } from '../i18n/I18nContext.js';
import { buildDiffHtml, buildLineDiff, parseUnifiedDiff } from './lineDiff.js';

// 惰性取（模块顶层不求 react-native-webview——纯 Node 测试与未装环境都能加载本模块）。
let WebViewComponent = null;
try {
  const webview = require('react-native-webview');
  WebViewComponent = webview && webview.WebView ? webview.WebView : null;
} catch (error) {
  WebViewComponent = null;
}

export default function DiffView({ unified, oldText, newText, title = '', height = 320 }) {
  const { theme } = useTheme();
  const { t } = useTranslation();
  const model = useMemo(() => {
    if (typeof unified === 'string') return parseUnifiedDiff(unified);
    return buildLineDiff(oldText, newText);
  }, [unified, oldText, newText]);
  const html = useMemo(
    () => buildDiffHtml(model, { dark: theme && theme.id !== 'light', title }),
    [model, theme, title]
  );

  if (!WebViewComponent) {
    return (
      <View style={[styles.fallback, { height }]}>
        <Text style={styles.fallbackText}>{t('workspace.diff.webviewMissing')}</Text>
      </View>
    );
  }
  return (
    <View style={[styles.wrap, { height }]}>
      <WebViewComponent
        originWhitelist={['about:blank', 'data:*']}
        source={{ html }}
        style={styles.web}
        scrollEnabled
        nestedScrollEnabled
        javaScriptEnabled={false}
        domStorageEnabled={false}
        setSupportMultipleWindows={false}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#ffffff',
  },
  web: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  fallback: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
  },
  fallbackText: {
    color: '#8c959f',
    fontSize: 12,
    paddingHorizontal: 12,
    textAlign: 'center',
  },
});
