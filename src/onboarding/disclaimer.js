import React, { useEffect, useMemo, useState } from 'react';
import { Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import ChapterSections from '../books/ChapterSections.js';
import {
  DISCLAIMER_SECTIONS,
  DISCLAIMER_TEXT,
  DISCLAIMER_EN_NOTICE,
  getDisclaimerSections,
} from './disclaimerContent.js';
import { useTheme } from '../theme/ThemeContext.js';
import { useTranslation } from '../i18n/I18nContext.js';

// 条款文本与结构化章节在 `disclaimerContent.js`（零依赖纯数据模块，Node 可测）。
// 这里只保留展示组件并原样再导出，既有 `from './disclaimer.js'` 的引用无需改动。
//
// 渲染来源：**默认渲染分节版**（权威条款，见 `disclaimerContent.js` 头注释）。用户读到
// 并据此勾选「同意」的就是分节版，所以弹窗必须让「用户看到的那份」= 「被记录为已同意的
// 那份」。
// 语言（2026-10-24 用户裁决）：默认跟随界面语言，页头提供「简体中文 / English」切换；
// 中文是权威/管辖文本，英文是参考译文（英文视图底部有提示行）。切换只影响**展示**，
// 同意记录不区分语言——两种语言是同一条款（同一 DISCLAIMER_VERSION）的两种呈现。
export { DISCLAIMER_SECTIONS, DISCLAIMER_TEXT };

// 切换器的两档：标签复用设置页语言选择的既有词条（两种界面语言下都显示原生写法
// 「简体中文」/「English」，不需要新词条）。id 与 disclaimerContent.getDisclaimerSections
// 的入参口径一致。
const LANG_OPTIONS = [
  { id: 'zh-CN', labelKey: 'settings.language.zh' },
  { id: 'en', labelKey: 'settings.language.en' },
];

export default function DisclaimerModal({ visible, title, content, sections, onClose }) {
  const { theme, fonts, tokens } = useTheme();
  const { t, localeId } = useTranslation();
  const resolvedTitle = title || t('onboarding.disclaimer.title');
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);

  // 语言默认跟随界面语言；每次打开弹窗都重置——手动切换只在本次弹窗内生效，
  // 不写存储（界面语言本身已有独立设置，条款语言跟着走是合理默认）。
  const [lang, setLang] = useState(localeId === 'en' ? 'en' : 'zh-CN');
  useEffect(() => {
    if (visible) setLang(localeId === 'en' ? 'en' : 'zh-CN');
  }, [visible, localeId]);

  // 渲染来源优先级：显式 `sections` > 显式 `content`（整段文案）> 默认分节版（随语言切换）。
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
  //
  // 切换器只在「内容由本组件自己解析」时出现：调用方显式传入 sections/content 时，
  // 内容不归本组件管、无法翻译，也就不显示切换（当前三个入口全部走默认渲染）。
  const ownsContent = !Array.isArray(sections) && content === undefined;
  const list = Array.isArray(sections)
    ? sections
    : (content === undefined ? getDisclaimerSections(lang) : null);
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.headerRow}>
            <Text style={styles.title} numberOfLines={1}>{resolvedTitle}</Text>
            {ownsContent ? (
              <View style={styles.langToggle}>
                {LANG_OPTIONS.map(option => (
                  <TouchableOpacity
                    key={option.id}
                    style={[styles.langChip, lang === option.id && styles.langChipActive]}
                    onPress={() => setLang(option.id)}
                    activeOpacity={0.7}
                  >
                    <Text
                      style={[styles.langChipText, lang === option.id && styles.langChipTextActive]}
                      numberOfLines={1}
                    >
                      {t(option.labelKey)}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            ) : null}
          </View>
          <ScrollView style={styles.body}>
            {list ? (
              <ChapterSections sections={list} />
            ) : (
              <Text style={styles.text}>{content}</Text>
            )}
            {ownsContent && lang === 'en' ? (
              <Text style={styles.langNotice}>{DISCLAIMER_EN_NOTICE}</Text>
            ) : null}
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
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 12,
  },
  title: { color: theme.colors.text, fontSize: fonts.scaled(16), fontWeight: '800', flexShrink: 1 },
  langToggle: {
    flexDirection: 'row',
    borderRadius: 999,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.divider,
    overflow: 'hidden',
  },
  langChip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    backgroundColor: 'transparent',
  },
  langChipActive: {
    backgroundColor: theme.colors.primary,
  },
  langChipText: {
    color: theme.colors.textMuted,
    fontSize: fonts.scaled(12),
    fontWeight: '600',
  },
  langChipTextActive: {
    color: theme.colors.primaryContrast,
  },
  body: { flexGrow: 0 },
  text: { color: theme.colors.textMuted, fontSize: fonts.scaled(14), lineHeight: fonts.scaled(22) },
  langNotice: {
    color: theme.colors.textMuted,
    fontSize: fonts.scaled(11),
    marginTop: 10,
    fontStyle: 'italic',
  },
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
