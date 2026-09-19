import React, { useMemo } from 'react';
import { Alert, Linking, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme } from './theme/ThemeContext';

// 章节的合规警告与外部链接。
// 警告文案显示在链接正上方（显著位置），点击链接时再弹出一次确认，确认后才打开。
export default function ChapterNotice({ warning, links }) {
  const { theme, fonts } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts), [theme, fonts]);
  const list = Array.isArray(links) ? links.filter(item => item && item.url) : [];
  if (!warning && list.length === 0) return null;

  const openLink = link => {
    const url = String(link.url || '');
    if (!url) return;
    const message = warning
      ? `${warning}\n\n即将打开：${url}`
      : `即将打开外部链接：${url}`;
    Alert.alert(link.label || '外部链接', message, [
      { text: '取消', style: 'cancel' },
      { text: '继续打开', onPress: () => { Linking.openURL(url).catch(() => {}); } },
    ]);
  };

  return (
    <View>
      {warning ? (
        <View style={styles.noticeBox}>
          <Ionicons name="warning-outline" size={15} color={theme.colors.danger} />
          <Text style={styles.noticeText}>{warning}</Text>
        </View>
      ) : null}
      {list.map((link, index) => (
        <TouchableOpacity
          key={`${link.url}-${index}`}
          style={styles.linkRow}
          onPress={() => openLink(link)}
          activeOpacity={0.8}
          accessibilityRole="link"
          accessibilityLabel={`打开 ${link.label || link.url}`}
        >
          <Ionicons name="open-outline" size={15} color={theme.colors.primarySoft} />
          <Text style={styles.linkLabel} numberOfLines={1}>{link.label}</Text>
          <Ionicons name="chevron-forward" size={15} color={theme.colors.textFaint} />
        </TouchableOpacity>
      ))}
    </View>
  );
}

const createStyles = (theme, fonts) => StyleSheet.create({
  noticeBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: 'rgba(255,107,107,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(255,107,107,0.35)',
    borderRadius: 10,
    padding: 10,
    marginBottom: 10,
  },
  noticeText: {
    flex: 1,
    color: theme.colors.text,
    fontSize: fonts.scaled(12),
    lineHeight: fonts.scaled(18),
    marginLeft: 8,
  },
  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 8,
  },
  linkLabel: {
    flex: 1,
    color: theme.colors.primarySoft,
    fontSize: fonts.scaled(14),
    fontWeight: '700',
    marginLeft: 8,
  },
});
