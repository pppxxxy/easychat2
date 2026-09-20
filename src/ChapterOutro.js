import React, { useMemo } from 'react';
import { Alert, Linking, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme } from './theme/ThemeContext';

// 章末附加区块：标题 + 正文 + 要点列表 + 外链 + 免责声明。
// 外链点击先 Alert 二次确认，确认文案用 linkNotice（缺省回退到通用提示），确认后才打开。
export default function ChapterOutro({ outro }) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  if (!outro) return null;

  const { title, body, bullets, link, linkNotice, disclaimer } = outro;
  const bulletList = Array.isArray(bullets) ? bullets.filter(Boolean) : [];
  const hasLink = link && link.url;

  const openLink = () => {
    const url = String(link.url || '');
    if (!url) return;
    const message = `${linkNotice || '即将打开外部链接。'}\n\n即将打开：${url}`;
    Alert.alert(link.label || '外部链接', message, [
      { text: '取消', style: 'cancel' },
      { text: '继续打开', onPress: () => { Linking.openURL(url).catch(() => {}); } },
    ]);
  };

  return (
    <View style={styles.wrap}>
      {title ? <Text style={styles.title}>{title}</Text> : null}
      {body ? <Text style={styles.body}>{body}</Text> : null}
      {bulletList.length > 0 ? (
        <View style={styles.bullets}>
          {bulletList.map((item, index) => (
            <View key={`bullet-${index}`} style={styles.bulletRow}>
              <Text style={styles.bulletDot}>·</Text>
              <Text style={styles.bulletText}>{item}</Text>
            </View>
          ))}
        </View>
      ) : null}
      {hasLink ? (
        <TouchableOpacity
          style={styles.linkRow}
          onPress={openLink}
          activeOpacity={0.8}
          accessibilityRole="link"
          accessibilityLabel={`打开 ${link.label || link.url}`}
        >
          <Ionicons name="open-outline" size={15} color={theme.colors.primarySoft} />
          <Text style={styles.linkLabel} numberOfLines={1}>{link.label || link.url}</Text>
          <Ionicons name="chevron-forward" size={15} color={theme.colors.textFaint} />
        </TouchableOpacity>
      ) : null}
      {disclaimer ? (
        <View style={styles.disclaimerBox}>
          <Ionicons name="information-circle-outline" size={15} color={theme.colors.primarySoft} />
          <Text style={styles.disclaimerText}>{disclaimer}</Text>
        </View>
      ) : null}
    </View>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  container: {
    marginTop: tokens.spacing.md,
    paddingTop: tokens.spacing.md,
    borderTopWidth: tokens.border.thin,
    borderTopColor: theme.colors.divider,
  },
  title: {
    color: theme.colors.text,
    fontSize: fonts.scaled(14),
    fontWeight: '800',
    marginBottom: tokens.spacing.xs + 2,
  },
  body: {
    color: theme.colors.textMuted,
    fontSize: fonts.scaled(13),
    lineHeight: fonts.scaled(20),
    marginBottom: tokens.spacing.sm,
  },
  bullets: { marginBottom: tokens.spacing.sm },
  bulletRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: tokens.spacing.xs },
  bulletDot: {
    color: theme.colors.primarySoft,
    fontSize: fonts.scaled(13),
    lineHeight: fonts.scaled(20),
    marginRight: tokens.spacing.xs + 2,
  },
  bulletText: {
    flex: 1,
    color: theme.colors.text,
    fontSize: fonts.scaled(13),
    lineHeight: fonts.scaled(20),
  },
  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surface,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    borderRadius: tokens.radius.md,
    paddingVertical: tokens.spacing.sm + 2,
    paddingHorizontal: tokens.spacing.md,
    marginBottom: tokens.spacing.sm,
  },
  linkLabel: {
    flex: 1,
    color: theme.colors.primarySoft,
    fontSize: fonts.scaled(14),
    fontWeight: '700',
    marginLeft: tokens.spacing.sm,
  },
  disclaimerBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: theme.colors.surfaceAlt,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    borderRadius: tokens.radius.md,
    padding: tokens.spacing.sm + 2,
  },
  disclaimerText: {
    flex: 1,
    color: theme.colors.textMuted,
    fontSize: fonts.scaled(12),
    lineHeight: fonts.scaled(18),
    marginLeft: tokens.spacing.sm,
  },
});
