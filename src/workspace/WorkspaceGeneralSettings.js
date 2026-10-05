// 工作区「综合设置」：语言、工作模式、帮助与教学。
//
// 语言走 I18nContext 的 setLocaleId（与「设置 → 外观」同一份存储，改哪边都立即生效）；
// 工作模式与底部设置列表共用同一个回调，不在这里另存一份状态。

import React, { useMemo, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import TutorialModal from '../TutorialModal.js';
import { useTheme } from '../theme/ThemeContext.js';
import { useTranslation } from '../i18n/I18nContext.js';

const MODE_CHOICES = ['ask', 'read', 'write'];

function Chip({ label, active, onPress, styles }) {
  return (
    <TouchableOpacity
      style={[styles.chip, active && styles.chipActive]}
      onPress={onPress}
      activeOpacity={0.8}
    >
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

export default function WorkspaceGeneralSettings({
  visible,
  onClose,
  mode = 'ask',
  onSelectMode,
}) {
  const { theme, fonts, tokens } = useTheme();
  const { t, localeId, locales, setLocaleId } = useTranslation();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const [tutorialOpen, setTutorialOpen] = useState(false);

  const localeList = Array.isArray(locales) && locales.length
    ? locales
    : [{ id: 'zh-CN', label: '简体中文' }];

  return (
    <>
      <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
        <Pressable style={styles.backdrop} onPress={onClose}>
          <Pressable style={styles.sheet} onPress={() => {}}>
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>{t('workspace.general.title')}</Text>
              <TouchableOpacity onPress={onClose} hitSlop={8}>
                <Ionicons name="close" size={20} color={theme.colors.textMuted} />
              </TouchableOpacity>
            </View>
            <ScrollView style={styles.sheetBody} contentContainerStyle={styles.sheetBodyContent}>
              <Text style={styles.sectionLabel}>{t('workspace.general.language')}</Text>
              <View style={styles.chipWrap}>
                {localeList.map(item => (
                  <Chip
                    key={item.id}
                    label={item.label || item.id}
                    active={String(item.id) === String(localeId)}
                    onPress={() => setLocaleId && setLocaleId(item.id)}
                    styles={styles}
                  />
                ))}
              </View>
              <Text style={styles.hint}>{t('workspace.general.language.hint')}</Text>

              <Text style={styles.sectionLabel}>{t('workspace.general.mode')}</Text>
              <View style={styles.chipWrap}>
                {MODE_CHOICES.map(choice => (
                  <Chip
                    key={choice}
                    label={t(`settings.workspace.mode.${choice}`)}
                    active={mode === choice}
                    onPress={() => onSelectMode && onSelectMode(choice)}
                    styles={styles}
                  />
                ))}
              </View>
              <Text style={styles.hint}>
                {t(`settings.workspace.hint.${MODE_CHOICES.includes(mode) ? mode : 'ask'}`)}
              </Text>

              <Text style={styles.sectionLabel}>{t('workspace.general.help')}</Text>
              <TouchableOpacity
                style={styles.helpRow}
                onPress={() => setTutorialOpen(true)}
                activeOpacity={0.8}
              >
                <Ionicons name="school-outline" size={17} color={theme.colors.primarySoft} />
                <View style={styles.helpTextBlock}>
                  <Text style={styles.helpTitle}>{t('workspace.general.help.action')}</Text>
                  <Text style={styles.hint}>{t('workspace.general.help.hint')}</Text>
                </View>
                <Ionicons name="chevron-forward" size={15} color={theme.colors.textFaint} />
              </TouchableOpacity>
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      <TutorialModal visible={tutorialOpen} onClose={() => setTutorialOpen(false)} />
    </>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: theme.colors.overlay,
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: theme.colors.surfaceAlt,
    borderTopLeftRadius: tokens.radius.lg,
    borderTopRightRadius: tokens.radius.lg,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.divider,
    maxHeight: '78%',
    paddingBottom: 10,
    ...tokens.elevation(2, theme),
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: tokens.border.thin,
    borderBottomColor: theme.colors.divider,
  },
  sheetTitle: { color: theme.colors.text, fontSize: fonts.scaled(15), fontWeight: '800' },
  sheetBody: { flexGrow: 0 },
  sheetBodyContent: { paddingHorizontal: 16, paddingBottom: 16 },
  sectionLabel: {
    color: theme.colors.text,
    fontSize: fonts.scaled(13),
    fontWeight: '700',
    marginTop: 16,
    marginBottom: 8,
  },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap' },
  chip: {
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    borderRadius: tokens.radius.sm,
    paddingHorizontal: 12,
    paddingVertical: 7,
    marginRight: 8,
    marginBottom: 8,
  },
  chipActive: {
    backgroundColor: theme.colors.primaryAlpha(0.2),
    borderColor: theme.colors.primary,
  },
  chipText: { color: theme.colors.textMuted, fontSize: fonts.scaled(12), fontWeight: '600' },
  chipTextActive: { color: theme.colors.primarySoft },
  hint: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(11),
    lineHeight: fonts.scaled(16),
    marginTop: 2,
  },
  helpRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    borderRadius: tokens.radius.md,
    paddingHorizontal: 12,
    paddingVertical: 11,
  },
  helpTextBlock: { flex: 1, marginLeft: 10, marginRight: 8 },
  helpTitle: { color: theme.colors.text, fontSize: fonts.scaled(13), fontWeight: '600' },
});
