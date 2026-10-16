// 应用内公告弹层（版本更新说明）。纯展示组件：数据由调用方传入，本组件不读网络/存储。
//
// 安全（SECURITY.md 语义对齐）：正文经 announcements/release.markdownToPlainText 文本化，
// 是**纯 Text**，不渲染任何可点击链接、不解析 HTML。用户要访问 release 页必须显式点
// 「在浏览器打开」按钮（走调用方注入的 onOpenRelease → Linking），不是点正文里的链接。
import React, { useMemo } from 'react';
import { Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme } from '../theme/ThemeContext.js';
import { useTranslation } from '../i18n/I18nContext.js';
import { markdownToPlainText } from './release.js';

export default function AnnouncementModal({
  visible,
  release,
  onClose,
  onDismissVersion,
  onOpenRelease,
}) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const { t } = useTranslation();
  const body = useMemo(
    // 空 body 时给一句兜底（只有版本号也比空白弹层强）。
    () => markdownToPlainText(release && release.body) || t('announcement.emptyBody'),
    [release, t]
  );
  const title = (release && (release.name || release.tag)) || '';

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Ionicons name="megaphone-outline" size={18} color={theme.colors.primary} />
            <Text style={styles.headerTitle}>{t('announcement.title')}</Text>
          </View>

          <View style={styles.versionRow}>
            <Text style={styles.version}>{release && release.version ? `v${release.version}` : ''}</Text>
            {release && release.publishedAt ? (
              <Text style={styles.date}>{release.publishedAt.slice(0, 10)}</Text>
            ) : null}
          </View>
          {title ? <Text style={styles.releaseName}>{title}</Text> : null}

          <ScrollView style={styles.bodyScroll} contentContainerStyle={styles.bodyContent}>
            <Text style={styles.bodyText} selectable>{body}</Text>
          </ScrollView>

          {onOpenRelease ? (
            <TouchableOpacity
              style={styles.linkRow}
              onPress={onOpenRelease}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={t('announcement.openRelease')}
            >
              <Ionicons name="open-outline" size={15} color={theme.colors.primaryMuted} />
              <Text style={styles.linkText}>{t('announcement.openRelease')}</Text>
            </TouchableOpacity>
          ) : null}

          <View style={styles.actions}>
            {/* 「不再提示此版本」：只对**当前这个版本**生效（存版本号），
                所以下次发新版仍会照常弹——这是任务书要求的语义。 */}
            {onDismissVersion && release && release.version ? (
              <TouchableOpacity
                style={styles.secondaryButton}
                onPress={() => onDismissVersion(release.version)}
                activeOpacity={0.7}
                accessibilityRole="button"
              >
                <Text style={styles.secondaryText}>{t('announcement.doNotShowAgain')}</Text>
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity
              style={styles.primaryButton}
              onPress={onClose}
              activeOpacity={0.8}
              accessibilityRole="button"
            >
              <Text style={styles.primaryText}>{t('common.confirm')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: theme.colors.overlay,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  sheet: {
    width: '100%',
    maxWidth: 480,
    maxHeight: '80%',
    backgroundColor: theme.colors.surface,
    borderRadius: tokens.radius.lg,
    padding: 18,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerTitle: {
    color: theme.colors.text,
    fontSize: fonts.scaled(16),
    fontWeight: '700',
  },
  versionRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 8,
    marginTop: 10,
  },
  version: {
    color: theme.colors.primary,
    fontSize: fonts.scaled(15),
    fontWeight: '700',
  },
  date: { color: theme.colors.textFaint, fontSize: fonts.scaled(12) },
  releaseName: {
    color: theme.colors.textMuted,
    fontSize: fonts.scaled(13),
    marginTop: 4,
  },
  // 正文可滚动：release body 可能很长，不能让按钮被顶出屏幕。
  bodyScroll: { marginTop: 12, flexGrow: 0 },
  bodyContent: { paddingBottom: 4 },
  bodyText: {
    color: theme.colors.text,
    fontSize: fonts.scaled(13),
    lineHeight: fonts.scaled(20),
  },
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 14 },
  linkText: { color: theme.colors.primaryMuted, fontSize: fonts.scaled(13) },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: 10,
    marginTop: 16,
  },
  secondaryButton: { paddingVertical: 8, paddingHorizontal: 12 },
  secondaryText: { color: theme.colors.textMuted, fontSize: fonts.scaled(13) },
  primaryButton: {
    backgroundColor: theme.colors.primary,
    borderRadius: tokens.radius.md,
    paddingVertical: 9,
    paddingHorizontal: 18,
  },
  primaryText: {
    color: theme.colors.accentText,
    fontSize: fonts.scaled(13),
    fontWeight: '700',
  },
});
