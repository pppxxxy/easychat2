import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme } from './theme/ThemeContext';

// 分节内容：图标 + 标题 + 正文 + 可选要点，用于免责声明等结构化条款。
export default function ChapterSections({ sections = [] }) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const list = Array.isArray(sections) ? sections.filter(Boolean) : [];
  if (list.length === 0) return null;

  return (
    <View style={styles.wrap}>
      {list.map((section, index) => (
        <View
          key={section.title || `section-${index}`}
          style={[styles.section, index > 0 && styles.sectionDivided]}
        >
          <View style={styles.head}>
            {section.icon ? (
              <Ionicons name={section.icon} size={tokens.iconSize.md} color={theme.colors.primaryMuted} />
            ) : null}
            {section.title ? (
              <Text style={[styles.title, section.icon ? styles.titleSpaced : null]}>{section.title}</Text>
            ) : null}
          </View>
          {section.body ? <Text style={styles.body}>{section.body}</Text> : null}
          {(section.bullets || []).map((bullet, bulletIndex) => (
            <View key={`${section.title || index}-bullet-${bulletIndex}`} style={styles.bulletRow}>
              <Text style={styles.bulletDot}>•</Text>
              <Text style={styles.bulletText}>{bullet}</Text>
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  wrap: { marginBottom: tokens.spacing.sm },
  section: { paddingTop: tokens.spacing.sm },
  sectionDivided: { borderTopWidth: tokens.border.thin, borderTopColor: theme.colors.divider },
  head: { flexDirection: 'row', alignItems: 'center' },
  title: { color: theme.colors.text, fontSize: fonts.scaled(14), fontWeight: '700' },
  titleSpaced: { marginLeft: tokens.spacing.sm },
  body: {
    color: theme.colors.textMuted,
    fontSize: fonts.scaled(13),
    lineHeight: fonts.scaled(21),
    marginTop: tokens.spacing.xs + 2,
  },
  bulletRow: { flexDirection: 'row', alignItems: 'flex-start', marginTop: tokens.spacing.xs },
  bulletDot: { color: theme.colors.primaryMuted, fontSize: fonts.scaled(13), lineHeight: fonts.scaled(21), marginRight: tokens.spacing.sm },
  bulletText: { flex: 1, color: theme.colors.textMuted, fontSize: fonts.scaled(13), lineHeight: fonts.scaled(21) },
});
