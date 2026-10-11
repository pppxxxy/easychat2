// 对话导出面板：从聊天页「⋯」菜单打开，把当前会话导出为长图 / Markdown / HTML。
// 长图用 react-native-view-shot 截取 ShareCard（整段内容），文本走 storage/chatExport 写出，
// 最终统一经系统分享面板分享。全程本地，无服务器。
//
// 三种格式都给「所见即所得」的预览（2026-10-11 用户反馈：长图看不全、Markdown/HTML 没预览）：
// - 长图：卡片按预览区实测宽度渲染，预览与最终导出的图完全一致（此前卡片写死 360，
//   比预览区宽，两侧被裁掉，正文看不全）；
// - Markdown：渲染成阅读效果（接近笔记软件里打开的样子）；
// - HTML：用 WebView 内嵌渲染导出页，与浏览器打开一致；缺 WebView 时退回文字提示。

import React, { useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import * as Sharing from 'expo-sharing';
import { captureRef } from 'react-native-view-shot';
import Ionicons from '@expo/vector-icons/Ionicons';
import Markdown from 'react-native-markdown-display';

import { useTheme } from '../theme/ThemeContext.js';
import { useTranslation } from '../i18n/I18nContext.js';
import { createChatStyles } from './chatStyles.js';
import { createExportStyles } from './exportStyles.js';
import ShareCard from './ShareCard.js';
import { createMarkdownStyles } from './assistantRender.js';
import { clampMarkdownText } from './markdownGuard.js';
import {
  buildExportEntries,
  collectExportMessages,
  exportFileName,
  formatExportTime,
  toHtml,
  toMarkdown,
} from './conversationExport.js';
import { persistChatExportImage, writeChatExportText } from '../storage/chatExport.js';

const FORMATS = ['image', 'markdown', 'html'];

// 长图卡片宽度上限：手机上铺满预览区，平板上不至于拉成一条。
const MAX_CARD_WIDTH = 420;

// react-native-webview 按可选能力惰性取（与 workspace/DiffView 同款）：未装或纯 Node
// 环境下本模块仍能加载；缺 WebView 时 HTML 预览退回一行文字提示，不影响导出本身。
let WebViewComponent = null;
try {
  const webview = require('react-native-webview');
  WebViewComponent = webview && webview.WebView ? webview.WebView : null;
} catch (error) {
  WebViewComponent = null;
}

export default function ConversationExportModal({
  visible,
  onClose,
  messages,
  title,
  characterName,
  userName,
  isGroup,
}) {
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
  const { height: windowHeight } = useWindowDimensions();
  // 导出样式单独成模块（chatStyles 已 1500+ 行）；标题等通用键仍取自 chatStyles。
  const styles = useMemo(
    () => ({
      ...createChatStyles(theme, fonts, tokens),
      ...createExportStyles(theme, fonts, tokens),
    }),
    [theme, fonts, tokens]
  );
  const [format, setFormat] = useState('image');
  const [busy, setBusy] = useState(false);
  const [previewWidth, setPreviewWidth] = useState(0);
  const scrollRef = useRef(null);

  const meta = useMemo(() => {
    const collected = collectExportMessages(messages);
    const exportedAt = formatExportTime(Date.now());
    const entries = buildExportEntries(collected.messages, {
      userName,
      characterName: isGroup ? t('chat.export.groupName') : characterName,
    });
    return {
      entries,
      header: {
        title: String(title || '').trim() || t('chat.export.defaultTitle'),
        exportedAt,
        truncated: collected.truncated,
        omitted: collected.omitted,
        count: entries.length,
      },
    };
  }, [messages, title, characterName, userName, isGroup, t]);

  const empty = meta.entries.length === 0;

  // 预览区高度：占屏幕一部分并夹住上下限，保证弹层（maxHeight 82%）里放得下。
  const previewHeight = useMemo(
    () => Math.min(400, Math.max(200, Math.round(windowHeight * 0.38))),
    [windowHeight]
  );
  // 卡片宽度 = 预览区实测宽度（去掉 1px 边框），再夹到 [200, MAX_CARD_WIDTH]。
  const cardWidth = previewWidth > 0
    ? Math.min(MAX_CARD_WIDTH, Math.max(200, Math.floor(previewWidth - 2)))
    : 0;

  const markdownStyles = useMemo(
    () => createMarkdownStyles(theme, fonts, tokens, theme.colors.text),
    [theme, fonts, tokens]
  );
  // 预览用的文本：与实际导出的文件同源（同一个 toMarkdown / toHtml）。
  // Markdown 走长度上限防护（markdown-it 的 linkify 有 ReDoS，见 markdownGuard）。
  const markdownPreview = useMemo(
    () => (empty ? '' : clampMarkdownText(toMarkdown(meta.entries, meta.header)).text),
    [empty, meta]
  );
  const htmlPreview = useMemo(
    () => (empty ? '' : toHtml(meta.entries, meta.header)),
    [empty, meta]
  );

  const shareFile = async (uri, mimeType) => {
    const available = typeof Sharing.isAvailableAsync === 'function'
      ? await Sharing.isAvailableAsync()
      : true;
    if (!available) {
      Alert.alert(t('chat.export.shareUnavailable.title'), t('chat.export.shareUnavailable.body'));
      return;
    }
    await Sharing.shareAsync(uri, { mimeType, dialogTitle: t('chat.export.shareDialog') });
  };

  const run = async task => {
    if (busy || empty) return;
    setBusy(true);
    try {
      await task();
    } catch (error) {
      Alert.alert(t('chat.export.failed.title'), t('chat.export.failed.body'));
    } finally {
      setBusy(false);
    }
  };

  const handleShareImage = () => run(async () => {
    // 等待离屏卡片完成布局/图片加载后再截，避免截到空白。
    await new Promise(resolve => setTimeout(resolve, 250));
    const tmpUri = await captureRef(scrollRef, {
      format: 'png',
      quality: 1,
      result: 'tmpfile',
      snapshotContentContainer: true,
    });
    const { uri } = await persistChatExportImage({
      tmpUri,
      fileName: exportFileName(meta.header, 'png'),
    });
    await shareFile(uri, 'image/png');
  });

  const handleShareText = kind => run(async () => {
    const content = kind === 'markdown'
      ? toMarkdown(meta.entries, meta.header)
      : toHtml(meta.entries, meta.header);
    const ext = kind === 'markdown' ? 'md' : 'html';
    const { uri } = await writeChatExportText({
      fileName: exportFileName(meta.header, ext),
      content,
    });
    await shareFile(uri, kind === 'markdown' ? 'text/markdown' : 'text/html');
  });

  const labels = {
    image: t('chat.export.format.image'),
    markdown: t('chat.export.format.markdown'),
    html: t('chat.export.format.html'),
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.exportBackdrop}>
        {/* 关闭层铺满整屏、放在弹层之下（同级、先渲染）：弹层里的 WebView / ScrollView
            就不会被 Touchable 包住，滚动不受影响；点弹层外的空白仍能关闭。 */}
        <TouchableOpacity
          style={StyleSheet.absoluteFill}
          activeOpacity={1}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={t('common.close')}
        />
        {/* box-none：本层自己不接触摸（否则它的 padding 环会挡住下面的关闭层），
            但子元素（弹层）照常接。水平内缩与限宽由本层 padding + 共享的
            styles.sheetWidth 提供（与其它聊天弹窗同口径）。 */}
        <View style={styles.exportSheetLayer} pointerEvents="box-none">
          <View
            style={[styles.exportSheet, styles.sheetWidth]}
            accessibilityViewIsModal
            importantForAccessibility="yes"
          >
          <View style={styles.exportHeader}>
            <Text style={styles.modalTitle}>{t('chat.export.title')}</Text>
            <TouchableOpacity onPress={onClose} accessibilityRole="button" accessibilityLabel={t('common.close')}>
              <Ionicons name="close" size={20} color={theme.colors.textFaint} />
            </TouchableOpacity>
          </View>

          <View style={styles.exportSegments}>
            {FORMATS.map(key => (
              <TouchableOpacity
                key={key}
                style={[styles.exportSegment, format === key && styles.exportSegmentActive]}
                onPress={() => setFormat(key)}
                activeOpacity={0.8}
              >
                <Text style={[styles.exportSegmentText, format === key && styles.exportSegmentTextActive]}>
                  {labels[key]}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {empty ? (
            <Text style={styles.exportHint}>{t('chat.export.empty')}</Text>
          ) : (
            <>
              {format === 'image' ? null : (
                <Text style={styles.exportHint}>
                  {format === 'markdown' ? t('chat.export.hint.markdown') : t('chat.export.hint.html')}
                </Text>
              )}
              <Text style={styles.exportPreviewCaption}>
                {t('chat.export.preview.caption', { count: meta.header.count })}
              </Text>
              <View
                style={[styles.exportPreviewWrap, { height: previewHeight }]}
                onLayout={event => setPreviewWidth(event.nativeEvent.layout.width)}
              >
                {format === 'image' ? (
                  <ScrollView
                    ref={scrollRef}
                    style={styles.exportPreviewScroll}
                    contentContainerStyle={styles.exportPreviewCenter}
                  >
                    {/* 实测宽度出来后才渲染卡片，避免先用兜底宽度画一帧再跳。 */}
                    {cardWidth > 0 ? (
                      <ShareCard
                        entries={meta.entries}
                        meta={meta.header}
                        styles={styles}
                        width={cardWidth}
                      />
                    ) : null}
                  </ScrollView>
                ) : null}

                {format === 'markdown' ? (
                  <ScrollView
                    style={styles.exportPreviewScroll}
                    contentContainerStyle={styles.exportPreviewPad}
                  >
                    <Markdown style={markdownStyles}>{markdownPreview}</Markdown>
                  </ScrollView>
                ) : null}

                {format === 'html' ? (
                  WebViewComponent ? (
                    <WebViewComponent
                      originWhitelist={['about:blank', 'data:*']}
                      source={{ html: htmlPreview }}
                      style={styles.exportPreviewWeb}
                      scrollEnabled
                      nestedScrollEnabled
                      javaScriptEnabled={false}
                      domStorageEnabled={false}
                      setSupportMultipleWindows={false}
                    />
                  ) : (
                    <ScrollView
                      style={styles.exportPreviewScroll}
                      contentContainerStyle={styles.exportPreviewPad}
                    >
                      <Text style={styles.exportPreviewFallback}>
                        {t('chat.export.preview.webviewMissing')}
                      </Text>
                    </ScrollView>
                  )
                ) : null}
              </View>
            </>
          )}

          <TouchableOpacity
            style={[styles.exportPrimaryButton, (busy || empty) && styles.exportPrimaryButtonDisabled]}
            disabled={busy || empty}
            activeOpacity={0.85}
            onPress={() => (format === 'image' ? handleShareImage() : handleShareText(format))}
          >
            {busy ? (
              <ActivityIndicator size="small" color={theme.colors.primaryContrast} />
            ) : (
              <Text style={styles.exportPrimaryButtonText}>
                {format === 'image' ? t('chat.export.shareImage') : t('chat.export.shareText')}
              </Text>
            )}
          </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}
