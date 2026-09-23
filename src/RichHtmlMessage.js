import React, { useCallback, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { buildRichHtmlDocument } from './richHtml';
import { useTheme } from './theme/ThemeContext';

// react-native-webview 是可选能力，缺失时降级为不渲染（与 ExtensionScreen 的游戏一致）。
let WebViewComponent = null;
try {
  const webview = require('react-native-webview');
  WebViewComponent = webview && webview.WebView ? webview.WebView : null;
} catch (error) {
  WebViewComponent = null;
}

// 用 WebView 渲染含 <style>/<script> 的助手消息：动态高度 + 命令按钮桥接。
export default function RichHtmlMessage({ html, onCommand }) {
  const { theme, fonts } = useTheme();
  const [height, setHeight] = useState(1);
  const loadedRef = useRef(false);

  const document = useMemo(() => buildRichHtmlDocument({
    bodyHtml: html,
    textColor: theme.colors.bubbleAssistantText,
    linkColor: theme.colors.primary,
    fontSize: fonts.scaled(15),
  }), [html, theme, fonts]);

  const onMessage = useCallback(event => {
    let payload = null;
    try {
      payload = JSON.parse(event.nativeEvent.data);
    } catch (error) {
      return;
    }
    if (!payload) return;
    if (payload.type === 'height') {
      const next = Math.max(1, Math.ceil(Number(payload.value) || 0));
      setHeight(prev => (Math.abs(prev - next) > 2 ? next : prev));
    } else if (payload.type === 'command' && payload.value && typeof onCommand === 'function') {
      onCommand(String(payload.value));
    }
  }, [onCommand]);

  // 只允许首次加载，拦截卡片里的链接跳转，避免 WebView 被导航到外部页面。
  const onShouldStartLoadWithRequest = useCallback(() => {
    if (!loadedRef.current) {
      loadedRef.current = true;
      return true;
    }
    return false;
  }, []);
  const onOpenWindow = useCallback(() => {}, []);

  if (!WebViewComponent) return null;

  return (
    <View style={styles.container}>
      <WebViewComponent
        originWhitelist={['*']}
        source={{ html: document }}
        style={[styles.webview, { height }]}
        containerStyle={styles.webviewContainer}
        javaScriptEnabled
        domStorageEnabled={false}
        allowFileAccess={false}
        allowsFullscreenVideo
        setSupportMultipleWindows
        scrollEnabled={false}
        onMessage={onMessage}
        onOpenWindow={onOpenWindow}
        onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { marginTop: 2 },
  webview: { width: '100%', backgroundColor: 'transparent' },
  webviewContainer: { backgroundColor: 'transparent' },
});
