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
  // 返回是逃生通道：永不收缩（flexShrink:0）。
  backButton: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6, paddingRight: 10, flexShrink: 0 },
  backButtonText: { color: theme.colors.textMuted, fontSize: fonts.scaled(14), marginLeft: 2 },
  // title 用固有宽度 + 可收缩（不是 flex:1）：空间不足时与 right 协商收缩并截断，
  // 而不是被 right 的长内容顶到 0。
  title: { color: theme.colors.text, fontSize: fonts.scaled(15), fontWeight: '700', marginLeft: 6, flexShrink: 1 },
  // marginLeft:'auto' 在空间富余时把动作推到最右（视觉与 flex:1 版本一致），
  // 溢出时归零、参与收缩协商——right 的长内容（如识图配置的动态模型名）不再
  // 把自身溢出屏幕，也不会把 title 整个挤没（2026-10-06 教学按钮被挤出屏幕）。
  right: { marginLeft: 'auto', flexShrink: 1 },
});
