// 子面板统一返回栏：左返回键 + 标题 + 右侧插槽（教学入口等）。
// 替换拓展页各子面板里逐字复制的 gameBar/backButton JSX。
import React, { useMemo } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme } from '../theme/ThemeContext.js';
import { useTranslation } from '../i18n/I18nContext.js';

export default function PaneHeader({ title, onBack, right }) {
  const { theme, fonts } = useTheme();
  const { t } = useTranslation();
  const styles = useMemo(() => createStyles(theme, fonts), [theme, fonts]);
  return (
    <View style={styles.bar}>
      <TouchableOpacity style={styles.backButton} onPress={onBack} activeOpacity={0.8}>
        <Ionicons name="chevron-back" size={18} color={theme.colors.textMuted} />
        <Text style={styles.backButtonText}>{t('ext.world.back')}</Text>
      </TouchableOpacity>
      <Text style={styles.title} numberOfLines={1}>{title}</Text>
      {right ? <View style={styles.right}>{right}</View> : null}
    </View>
  );
}

const createStyles = (theme, fonts) => StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 10,
  },
  backButton: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6, paddingRight: 10 },
  backButtonText: { color: theme.colors.textMuted, fontSize: fonts.scaled(14), marginLeft: 2 },
  title: { color: theme.colors.text, fontSize: fonts.scaled(15), fontWeight: '700', marginLeft: 6, flex: 1 },
  right: { marginLeft: 8 },
});
