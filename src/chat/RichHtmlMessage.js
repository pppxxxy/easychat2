import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View, useWindowDimensions } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';

import {
  RICH_HTML_MAX_RENDER_HEIGHT,
  RICH_HTML_SCROLL_PREVIEW_HEIGHT,
  RICH_HTML_SCROLL_THRESHOLD,
  buildRichHtmlCommandBridge,
  buildRichHtmlDocument,
  isViewportRichHtml,
  resolveViewportCardHeight,
} from './richHtml.js';
import { useTheme } from '../theme/ThemeContext.js';
import { recordDiagnostic } from '../storage/diagnostics.js';

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
// allowFullscreenVideo：聊天内富 HTML 卡片开启原生视频全屏按钮——
// 全屏由用户主动点击视频控件触发，退出即回到聊天上下文。
// hostHeight：宿主实测可用高度（Modal 传入）；列表预览不传，按屏幕比例估算并加硬上限。
export default function RichHtmlMessage({
  html,
  onCommand,
  fullWidth = false,
  allowFullscreenVideo = false,
  hostHeight = 0,
}) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const { height: windowHeight } = useWindowDimensions();
  const [height, setHeight] = useState(1);
  const [source, setSource] = useState(null);
  const [sourceError, setSourceError] = useState(false);
  // 大卡要走「写临时文件 → WebView 加载」的路径，期间若没有任何提示，
  // 用户在全屏 Modal 里只会看到一整屏空白。用 loading 明确反馈加载中。
  const [loading, setLoading] = useState(true);
  // 加载/渲染失败后的重试开关：改变 reloadKey 会让来源 effect 重新跑一遍。
  const [reloadKey, setReloadKey] = useState(0);
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
  // 视口型文档统一走 file://：内联 loadDataWithBaseURL 的不透明源下，
  // 100vh / 视口单位在部分机型的首帧会解析异常（塌成 0），整卡只剩背景色。
  // file:// 的行为与浏览器一致，也与超 512KB 大文档共用同一条路径。
  const useFileSource = largeDocument || viewportDocument;

  useEffect(() => {
    let cancelled = false;
    setHeight(1);
    setSourceError(false);
    setLoading(true);
    loadedRef.current = false;
    if (!useFileSource) {
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
  }, [document, useFileSource, reloadKey]);

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
    return (
      <View style={styles.container}>
        <Text style={styles.errorText}>HTML 内容加载失败</Text>
        <TouchableOpacity
          style={styles.retryButton}
          onPress={() => {
            setSourceError(false);
            setReloadKey(value => value + 1);
          }}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityLabel="重新加载卡片"
        >
          <Text style={styles.retryButtonText}>重试</Text>
        </TouchableOpacity>
      </View>
    );
  }
  if (!source) {
    // 占位高度与真实卡片一致，避免加载完成后列表跳动
    const placeholderHeight = viewportDocument ? viewportHeight : 160;
    return (
      <View style={[styles.container, styles.loadingBox, { height: placeholderHeight }]}>
        <ActivityIndicator color={theme.colors.primary} />
        <Text style={styles.loadingText}>卡片加载中…</Text>
      </View>
    );
  }

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
        // 之前没有 onLoadEnd / onError：加载失败时页面静默空白，无从判断。
        onLoadEnd={() => setLoading(false)}
        onError={() => {
          setLoading(false);
          setSourceError(true);
          recordDiagnostic('webview', new Error('富 HTML 卡片加载失败'), 'onError');
        }}
        // Android 渲染进程崩溃（重渐变/多层阴影的卡在部分机型会触发）表现为
        // WebView 静默空白，且不会触发 onError——必须单独接住才有恢复机会。
        onRenderProcessGone={() => {
          setLoading(false);
          setSourceError(true);
          recordDiagnostic('webview', new Error('富 HTML 卡片渲染进程崩溃'), 'onRenderProcessGone');
        }}
        onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
      />
      {loading ? (
        <View style={styles.loadingOverlay} pointerEvents="none">
          <ActivityIndicator color={theme.colors.primary} />
          <Text style={styles.loadingText}>卡片加载中…</Text>
        </View>
      ) : null}
    </View>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
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
    color: theme.colors.danger,
    fontSize: 12,
    paddingVertical: 8,
  },
  retryButton: {
    alignSelf: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: tokens.radius.sm,
    backgroundColor: theme.colors.surface,
    marginBottom: 8,
  },
  retryButtonText: {
    color: theme.colors.text,
    fontSize: 12,
    fontWeight: '700',
  },
  loadingBox: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingText: {
    color: theme.colors.textFaint,
    fontSize: 12,
    marginTop: 8,
  },
  webviewContainer: {
    width: '100%',
    minWidth: 0,
    alignSelf: 'stretch',
    backgroundColor: 'transparent',
  },
});
