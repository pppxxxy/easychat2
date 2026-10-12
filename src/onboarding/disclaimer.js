import React, { useMemo } from 'react';
import { Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import ChapterSections from '../books/ChapterSections.js';
import { DISCLAIMER_SECTIONS, DISCLAIMER_TEXT } from './disclaimerContent.js';
import { useTheme } from '../theme/ThemeContext.js';
import { useTranslation } from '../i18n/I18nContext.js';

// 条款文本与结构化章节在 `disclaimerContent.js`（零依赖纯数据模块，Node 可测）。
// 这里只保留展示组件并原样再导出，既有 `from './disclaimer.js'` 的引用无需改动。
//
// 渲染来源：**默认渲染分节版 `DISCLAIMER_SECTIONS`**（权威条款，见
// `disclaimerContent.js` 头注释）。用户读到并据此勾选「同意」的就是分节版，
// 所以弹窗必须让「用户看到的那份」= 「被记录为已同意的那份」。
export { DISCLAIMER_SECTIONS, DISCLAIMER_TEXT };

export default function DisclaimerModal({ visible, title, content, sections, onClose }) {
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
  const resolvedTitle = title || t('onboarding.disclaimer.title');
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  // 渲染来源优先级：显式 `sections` > 显式 `content`（整段文案）> 默认分节版。
  //
  // 为什么默认是分节版而不是整段：SECTIONS 是权威条款——用户实际读到、并据此勾选
  // 「同意」的就是它。若默认渲染整段 TEXT，就会出现「看到的是这份、按那份记录同意」
  // 的错位（这正是统一前的老行为）。
  //
  // 老代码写的是 `content = DISCLAIMER_TEXT` 默认值 + `content === DISCLAIMER_TEXT
  // ? DISCLAIMER_SECTIONS : null`：默认取 TEXT 却渲染 SECTIONS，靠一次隐晦的相等
  // 比较完成切换，读代码的人很容易以为渲染的是 TEXT。现在改成「没传 content 就是
  // 分节版」，把意图直说出来。
  //
  // 兼容：调用方显式传 `content`（自定义整段文案，如别处复用本弹窗）时仍按整段渲染。
  // 且 DISCLAIMER_TEXT 现已由 SECTIONS 派生，两者是同一份条款的两种形状，
  // 因此即便走到整段分支，文字也仍是权威那份，不存在条款口径分叉。
  const list = Array.isArray(sections)
    ? sections
    : (content === undefined ? DISCLAIMER_SECTIONS : null);
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
