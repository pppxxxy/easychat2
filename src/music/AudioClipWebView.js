// 一起听歌「截取片段」的原生侧宿主：一个隐藏的 WebView，负责把整首歌的 base64
// 解码、裁成 16kHz 单声道 30 秒 WAV 再回传。组件通过 ref 暴露命令式 clip()。
//
// 设计：WebView 常驻（挂载后保持存活，避免每次评论都重建、重新初始化 AudioContext）。
// 作业串行：同一时刻只处理一个 clip 请求；等待 ready 后再注入。任何异常都会
// reject，让调用方退回纯文字评论，不阻断功能。

import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import { StyleSheet, View } from 'react-native';

import { CLIP_DURATION_MS, CLIP_SAMPLE_RATE, buildAudioClipHtml } from './audioClip.js';

// react-native-webview 是可选能力，缺失时裁剪不可用（调用方退回整首/纯文字）。
let WebView = null;
try {
  ({ WebView } = require('react-native-webview'));
} catch (error) {
  WebView = null;
}

const CLIP_HTML = buildAudioClipHtml();

const AudioClipWebView = forwardRef(function AudioClipWebView(_props, ref) {
  const webRef = useRef(null);
  const readyRef = useRef(false);
  const jobRef = useRef(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      jobRef.current = null;
    };
  }, []);

  const settle = useCallback((error, result) => {
    const job = jobRef.current;
    jobRef.current = null;
    if (!job) return;
    if (error) job.reject(error);
    else job.resolve(result);
  }, []);

  const handleMessage = useCallback(event => {
    const data = String((event && event.nativeEvent && event.nativeEvent.data) || '');
    if (data === 'ready') {
      readyRef.current = true;
      return;
    }
    if (data.startsWith('ok:')) {
      settle(null, { base64: data.slice(3), mime: 'audio/wav' });
      return;
    }
    if (data.startsWith('err:')) {
      settle(new Error(data.slice(4) || 'clip-failed'));
    }
  }, [settle]);

  useImperativeHandle(ref, () => ({
    clip({ base64, startMs = 0, durationMs = CLIP_DURATION_MS } = {}) {
      const payload = String(base64 || '');
      if (!payload) return Promise.reject(new Error('empty-audio'));
      if (!readyRef.current || !webRef.current) return Promise.reject(new Error('clip-not-ready'));
      if (jobRef.current) return Promise.reject(new Error('clip-busy'));
      return new Promise((resolve, reject) => {
        jobRef.current = { resolve, reject };
        const script = `window.__clipAudio(${JSON.stringify(payload)}, ${Math.max(0, Math.floor(Number(startMs) || 0))}, ${Math.max(1, Math.floor(Number(durationMs) || CLIP_DURATION_MS))}, ${CLIP_SAMPLE_RATE}); true;`;
        try {
          webRef.current.injectJavaScript(script);
        } catch (error) {
          settle(error);
        }
      });
    },
  }), [settle]);

  if (!WebView) return null;

  return (
    <View style={styles.host} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <WebView
        ref={webRef}
        style={styles.web}
        originWhitelist={['*']}
        javaScriptEnabled
        domStorageEnabled={false}
        allowFileAccess
        setSupportMultipleWindows={false}
        scrollEnabled={false}
        source={{ html: CLIP_HTML }}
        onMessage={handleMessage}
        onError={() => settle(new Error('webview-error'))}
        onRenderProcessGone={() => settle(new Error('webview-gone'))}
      />
    </View>
  );
});

export default AudioClipWebView;

const styles = StyleSheet.create({
  host: {
    position: 'absolute',
    width: 1,
    height: 1,
    opacity: 0,
    left: -10,
    top: -10,
    overflow: 'hidden',
  },
  web: { width: 1, height: 1, backgroundColor: 'transparent' },
});
