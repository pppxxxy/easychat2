import React, { useMemo } from 'react';
import { Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import ChapterSections from '../books/ChapterSections.js';
import { DISCLAIMER_SECTIONS, DISCLAIMER_TEXT } from './disclaimerContent.js';
import { useTheme } from '../theme/ThemeContext.js';
import { useTranslation } from '../i18n/I18nContext.js';

// 条款文本与结构化章节在 `disclaimerContent.js`（零依赖纯数据模块，Node 可测）。
// 这里只保留展示组件并原样再导出，既有 `from './disclaimer.js'` 的引用无需改动。
export { DISCLAIMER_SECTIONS, DISCLAIMER_TEXT };

export default function DisclaimerModal({ visible, title, content = DISCLAIMER_TEXT, sections, onClose }) {
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
  const resolvedTitle = title || t('onboarding.disclaimer.title');
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const list = Array.isArray(sections)
    ? sections
    : (content === DISCLAIMER_TEXT ? DISCLAIMER_SECTIONS : null);
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <Text style={styles.title}>{resolvedTitle}</Text>
          <ScrollView style={styles.body}>
            {list ? (
              <ChapterSections sections={list} />
            ) : (
              <Text style={styles.text}>{content}</Text>
            )}
          </ScrollView>
          <TouchableOpacity style={styles.button} onPress={onClose} activeOpacity={0.8}>
            <Text style={styles.buttonText}>{t('onboarding.disclaimer.accept')}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.65)',
    justifyContent: 'center',
    padding: 24,
  },
  sheet: {
    backgroundColor: theme.colors.surface,
    borderRadius: tokens.radius.lg,
    padding: 18,
    maxHeight: '75%',
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.divider,
    ...tokens.elevation(2, theme),
  },
  title: { color: theme.colors.text, fontSize: fonts.scaled(16), fontWeight: '800', marginBottom: 12 },
  body: { flexGrow: 0 },
  text: { color: theme.colors.textMuted, fontSize: fonts.scaled(14), lineHeight: fonts.scaled(22) },
  button: {
    backgroundColor: theme.colors.primary,
    borderRadius: tokens.metrics.buttonRadius,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 16,
    ...tokens.elevation(3, theme),
  },
  buttonText: { color: theme.colors.primaryContrast, fontWeight: '800' },
});
