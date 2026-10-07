// 对话导出面板：从聊天页「⋯」菜单打开，把当前会话导出为长图 / Markdown / HTML。
// 长图用 react-native-view-shot 截取 ShareCard（整段内容），文本走 storage/chatExport 写出，
// 最终统一经系统分享面板分享。全程本地，无服务器。

import React, { useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import * as Sharing from 'expo-sharing';
import { captureRef } from 'react-native-view-shot';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme } from '../theme/ThemeContext.js';
import { useTranslation } from '../i18n/I18nContext.js';
import { createChatStyles } from './chatStyles.js';
import ShareCard from './ShareCard.js';
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
  const styles = useMemo(() => createChatStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const [format, setFormat] = useState('image');
  const [busy, setBusy] = useState(false);
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
      <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity style={styles.exportSheet} activeOpacity={1} onPress={() => {}}>
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
          ) : null}

          {format === 'image' ? (
            <View style={styles.exportPreviewWrap}>
              <ScrollView
                ref={scrollRef}
                style={{ maxHeight: 320 }}
                contentContainerStyle={{ alignItems: 'center' }}
              >
                <ShareCard entries={meta.entries} meta={meta.header} styles={styles} />
              </ScrollView>
            </View>
          ) : (
            <Text style={styles.exportHint}>
              {format === 'markdown' ? t('chat.export.hint.markdown') : t('chat.export.hint.html')}
            </Text>
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
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}
