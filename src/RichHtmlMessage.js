import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import * as FileSystem from 'expo-file-system';

import {
  RICH_HTML_MAX_RENDER_HEIGHT,
  RICH_HTML_SCROLL_PREVIEW_HEIGHT,
  RICH_HTML_SCROLL_THRESHOLD,
  buildRichHtmlCommandBridge,
  buildRichHtmlDocument,
  isViewportRichHtml,
  resolveViewportCardHeight,
} from './richHtml';
import { useTheme } from './theme/ThemeContext';

// react-native-webview 是可选能力，缺失时降级为不渲染（与 ExtensionScreen 的游戏一致）。
let WebViewComponent = null;
try {
  const webview = require('react-native-webview');
  WebViewComponent = webview && webview.WebView ? webview.WebView : null;
} catch (error) {
  WebViewComponent = null;
}

export const RICH_HTML_INLINE_SOURCE_LIMIT = 512 * 1024;
export { RICH_HTML_MAX_RENDER_HEIGHT, RICH_HTML_SCROLL_THRESHOLD };

function utf8ByteLength(value) {
  const text = String(value || '');
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

// 用 WebView 渲染含 <style>/<script> 的助手消息：动态高度 + 命令按钮桥接。
// allowFullscreenVideo：仅全屏 Modal 场景开启，列表预览不允许视频跳出聊天上下文。
// hostHeight：宿主实测可用高度（Modal 传入）；列表预览不传，按屏幕比例估算并加硬上限。
export default function RichHtmlMessage({
  html,
  onCommand,
  fullWidth = false,
  allowFullscreenVideo = false,
  hostHeight = 0,
}) {
  const { theme, fonts } = useTheme();
  const { height: windowHeight } = useWindowDimensions();
  const [height, setHeight] = useState(1);
  const [source, setSource] = useState(null);
  const [sourceError, setSourceError] = useState(false);
  const loadedRef = useRef(false);
  const temporaryUriRef = useRef('');

  // 视口型文档：高度由 WebView 视口决定，改用屏幕高度做固定宿主高度，避免测高死锁。
  const viewportDocument = useMemo(() => isViewportRichHtml(html), [html]);
  const viewportHeight = useMemo(
    () => resolveViewportCardHeight({ windowHeight, fullWidth, hostHeight }),
    [fullWidth, hostHeight, windowHeight]
  );

  const commandToken = useMemo(
    () => `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    [html, theme, fonts]
  );
  const heightToken = useMemo(
    () => `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    [html, theme, fonts]
  );
  const document = useMemo(() => buildRichHtmlDocument({
    bodyHtml: html,
    textColor: theme.colors.bubbleAssistantText,
    linkColor: theme.colors.primary,
    fontSize: fonts.scaled(15),
    heightToken,
  }), [heightToken, html, theme, fonts]);
  const commandBridge = useMemo(
    () => buildRichHtmlCommandBridge(commandToken),
    [commandToken]
  );
  const largeDocument = utf8ByteLength(document) > RICH_HTML_INLINE_SOURCE_LIMIT;

  useEffect(() => {
    let cancelled = false;
    setHeight(1);
    setSourceError(false);
    loadedRef.current = false;
    if (!largeDocument) {
      setSource({ html: document });
      return () => {
        cancelled = true;
        temporaryUriRef.current = '';
      };
    }
    const directory = FileSystem.cacheDirectory || FileSystem.documentDirectory || '';
    const uri = `${directory}easychat2-rich-html-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.html`;
    FileSystem.writeAsStringAsync(uri, document, {
      encoding: FileSystem.EncodingType.UTF8,
    }).then(writtenUri => {
      if (cancelled) {
        FileSystem.deleteAsync(writtenUri || uri, { idempotent: true }).catch(() => {});
        return;
      }
      temporaryUriRef.current = writtenUri || uri;
      setSource({ uri: temporaryUriRef.current });
    }).catch(() => {
      FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
      if (!cancelled) setSourceError(true);
    });
    return () => {
      cancelled = true;
      const temporaryUri = temporaryUriRef.current;
      temporaryUriRef.current = '';
      if (temporaryUri) FileSystem.deleteAsync(temporaryUri, { idempotent: true }).catch(() => {});
    };
  }, [document, largeDocument]);

  const onMessage = useCallback(event => {
    let payload = null;
    try {
      payload = JSON.parse(event.nativeEvent.data);
    } catch (error) {
      return;
    }
    if (!payload) return;
    if (payload.type === 'height' && !viewportDocument && payload.token === heightToken) {
       const next = Math.min(
         RICH_HTML_MAX_RENDER_HEIGHT,
         Math.max(1, Math.ceil(Number(payload.value) || 0))
       );
       setHeight(prev => (Math.abs(prev - next) > 2 ? next : prev));
    } else if (
      payload.type === 'command'
      && payload.gesture === true
      && payload.token === commandToken
      && payload.value
      && String(payload.value).length <= 500
      && typeof onCommand === 'function'
    ) {
      onCommand(String(payload.value), commandToken);
    }
  }, [commandToken, heightToken, onCommand, viewportDocument]);

  const onContentSizeChange = useCallback(event => {
    if (viewportDocument) return;
    const next = Number(event && event.nativeEvent && event.nativeEvent.contentSize
      ? event.nativeEvent.contentSize.height
      : 0);
     if (next > 0) {
       const bounded = Math.min(RICH_HTML_MAX_RENDER_HEIGHT, Math.ceil(next));
       setHeight(prev => (Math.abs(prev - bounded) > 2 ? bounded : prev));
     }
  }, [viewportDocument]);

  const onShouldStartLoadWithRequest = useCallback(request => {
    if (loadedRef.current) return false;
    loadedRef.current = true;
    const url = String(request && request.url || '');
    if (source && source.uri) return !url || url === source.uri;
    return !url || url === 'about:blank' || url.startsWith('data:');
  }, [source]);

  if (!WebViewComponent) return null;
  if (sourceError) {
    return <View style={styles.container}><Text style={styles.errorText}>HTML 内容加载失败</Text></View>;
  }
  if (!source) return <View style={styles.container} />;

  // 普通富 HTML 实测高度超过滚动阈值时不再整块撑满列表：
  // 卡片收成固定预览高度并允许内部滚动，用户可以在卡片内滚完再回到聊天。
  const contentScrollable = viewportDocument || height >= RICH_HTML_SCROLL_THRESHOLD;
  const displayHeight = viewportDocument
    ? viewportHeight
    : (height >= RICH_HTML_SCROLL_THRESHOLD ? RICH_HTML_SCROLL_PREVIEW_HEIGHT : height);

  return (
    <View style={styles.container}>
      <WebViewComponent
        originWhitelist={source.uri ? ['file://*'] : ['about:blank', 'data:*']}
        source={source}
        style={[styles.webview, { height: displayHeight }]}
        containerStyle={styles.webviewContainer}
        javaScriptEnabled
        domStorageEnabled
        allowFileAccess={!!source.uri}
        allowsFullscreenVideo={allowFullscreenVideo}
        setSupportMultipleWindows={false}
        onOpenWindow={() => {}}
        scrollEnabled={contentScrollable}
        nestedScrollEnabled={contentScrollable}
        injectedJavaScriptBeforeContentLoaded={commandBridge}
        onContentSizeChange={onContentSizeChange}
        onMessage={onMessage}
        onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
    minWidth: 0,
    alignSelf: 'stretch',
    marginTop: 2,
  },
  webview: {
    width: '100%',
    minWidth: 0,
    alignSelf: 'stretch',
    backgroundColor: 'transparent',
  },
   errorText: {
     color: '#b84a62',
     fontSize: 12,
     paddingVertical: 8,
   },
   webviewContainer: {
     width: '100%',
    minWidth: 0,
    alignSelf: 'stretch',
    backgroundColor: 'transparent',
  },
});
