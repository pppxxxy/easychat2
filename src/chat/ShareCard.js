// 分享卡片：把导出条目渲染成带气泡样式的长图内容，供 ConversationExportModal
// 用 react-native-view-shot 截图。纯展示组件，数据与样式由调用方注入。
//
// width：卡片宽度。导出面板传「预览区实测宽度」，让预览与最终导出的长图完全一致
// （2026-10-11：此前卡片写死 360，比预览区宽，两侧被裁掉，用户看不到完整内容）。

import React from 'react';
import { Text, View } from 'react-native';

import { useTranslation } from '../i18n/I18nContext.js';

export default function ShareCard({ entries, meta, styles, width }) {
  const { t } = useTranslation();
  const list = Array.isArray(entries) ? entries : [];
  const info = meta && typeof meta === 'object' ? meta : {};
  const widthStyle = Number(width) > 0 ? { width: Math.floor(Number(width)) } : null;
  return (
    <View style={[styles.shareCard, widthStyle]} collapsable={false}>
      <Text style={styles.shareCardTitle}>{info.title || t('chat.export.defaultTitle')}</Text>
      <Text style={styles.shareCardSub}>
        {t('chat.export.meta', { time: info.exportedAt || '', count: Number(info.count) || 0 })}
        {info.truncated ? (
          <Text style={styles.shareCardTrunc}>
            {t('chat.export.truncated', { count: Number(info.omitted) || 0 })}
          </Text>
        ) : null}
      </Text>
      {list.map((entry, index) => {
        const isUser = entry.role === 'user';
        return (
          <View
            key={`${index}-${entry.speaker}`}
            style={[styles.shareCardRow, isUser ? styles.shareCardRowRight : styles.shareCardRowLeft]}
          >
            <View style={[
              styles.shareCardBubble,
              isUser ? styles.shareCardBubbleUser : styles.shareCardBubbleAssistant,
            ]}>
              <Text style={[styles.shareCardMeta, !isUser && styles.shareCardMetaAssistant]}>
                {[entry.speaker, entry.time].filter(Boolean).join(' · ')}
              </Text>
              <Text style={[styles.shareCardBody, !isUser && styles.shareCardBodyAssistant]}>
                {entry.body}
              </Text>
            </View>
          </View>
        );
      })}
      <Text style={styles.shareCardFooter}>{t('chat.export.footer')}</Text>
    </View>
  );
}
