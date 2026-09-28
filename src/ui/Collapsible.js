import React, { useMemo, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme } from '../theme/ThemeContext.js';

// 折叠分组：标题行点击展开/收起内容。用于设置页把体积较大的区块（外观、生成参数等）
// 默认收起，避免一屏塞满选项。可受控（open + onToggle）或非受控（defaultOpen）。
export function CollapsibleSection({ title, icon, defaultOpen = false, open, onToggle, right, children, style }) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const [innerOpen, setInnerOpen] = useState(defaultOpen);
  const expanded = open === undefined ? innerOpen : open === true;
  const toggle = () => {
    if (open === undefined) setInnerOpen(v => !v);
    if (onToggle) onToggle(!expanded);
  };
  return (
    <View style={style}>
      <TouchableOpacity
        style={styles.head}
        onPress={toggle}
        activeOpacity={0.8}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
      >
        <View style={styles.headLeft}>
          {icon ? (
            <Ionicons name={icon} size={tokens.iconSize.sm + 1} color={theme.colors.textMuted} />
          ) : null}
          <Text style={[styles.headTitle, icon ? styles.headTitleSpaced : null]}>{title}</Text>
        </View>
        <View style={styles.headRight}>
          {right}
          <Ionicons
            name={expanded ? 'chevron-up' : 'chevron-down'}
            size={16}
            color={theme.colors.textFaint}
          />
        </View>
      </TouchableOpacity>
      {expanded ? <View style={styles.body}>{children}</View> : null}
    </View>
  );
}

// 折叠选择器：先显示当前选中项，点开才列出候选项，选中后自动收起。
// 用于避免把一大堆 API / 模型 / 人设 / 生图服务一次性罗列出来。
export function CollapsibleSelect({
  label,
  value,
  valueLabel,
  valueMeta,
  options = [],
  onSelect,
  placeholder = '未选择',
  emptyHint = '暂无可选项',
  right,
  style,
}) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const [open, setOpen] = useState(false);
  const selectedOption = options.find(option => option.value === value);
  const displayLabel = valueLabel !== undefined ? valueLabel : (selectedOption ? selectedOption.label : '');
  const displayMeta = valueMeta !== undefined ? valueMeta : (selectedOption ? selectedOption.meta : '');
  return (
    <View style={[styles.select, style]}>
      <TouchableOpacity
        style={styles.selectHead}
        onPress={() => setOpen(v => !v)}
        activeOpacity={0.8}
        accessibilityRole="button"
      >
        {label ? <Text style={styles.selectLabel}>{label}</Text> : null}
        <View style={styles.selectValueBox}>
          <Text style={styles.selectValue} numberOfLines={1}>
            {displayLabel || placeholder}
          </Text>
          {displayMeta ? (
            <Text style={styles.selectMeta} numberOfLines={1}>{displayMeta}</Text>
          ) : null}
        </View>
        {right}
        <Ionicons
          name={open ? 'chevron-up' : 'chevron-down'}
          size={16}
          color={theme.colors.textFaint}
        />
      </TouchableOpacity>
      {open ? (
        options.length === 0 ? (
          <Text style={styles.selectEmpty}>{emptyHint}</Text>
        ) : (
          <View style={styles.selectBody}>
            {options.map(option => {
              const active = option.value === value;
              return (
                <TouchableOpacity
                  key={option.value}
                  style={[styles.optionRow, active && styles.optionRowActive]}
                  onPress={() => { onSelect(option.value); setOpen(false); }}
                  activeOpacity={0.85}
                >
                  <View style={styles.optionInfo}>
                    <Text style={[styles.optionText, active && styles.optionTextActive]} numberOfLines={1}>
                      {option.label}
                    </Text>
                    {option.meta ? (
                      <Text style={styles.optionMeta} numberOfLines={1}>{option.meta}</Text>
                    ) : null}
                  </View>
                  {active ? <Ionicons name="checkmark" size={16} color={theme.colors.primary} /> : null}
                </TouchableOpacity>
              );
            })}
          </View>
        )
      ) : null}
    </View>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: tokens.spacing.sm + 2,
  },
  headLeft: { flexDirection: 'row', alignItems: 'center', flexShrink: 1 },
  headTitle: { color: theme.colors.text, fontSize: fonts.scaled(15), fontWeight: '800' },
  headTitleSpaced: { marginLeft: 8 },
  headRight: { flexDirection: 'row', alignItems: 'center' },
  body: { marginTop: tokens.spacing.xs },

  select: {
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    borderRadius: tokens.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
    overflow: 'hidden',
  },
  selectHead: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: tokens.spacing.sm + 2,
    paddingHorizontal: tokens.spacing.md,
  },
  selectLabel: {
    color: theme.colors.textMuted,
    fontSize: fonts.scaled(13),
    fontWeight: '600',
    marginRight: tokens.spacing.sm,
  },
  selectValueBox: { flex: 1, marginRight: tokens.spacing.sm },
  selectValue: { color: theme.colors.text, fontSize: fonts.scaled(14), fontWeight: '700' },
  selectMeta: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), marginTop: 2 },
  selectEmpty: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(12),
    paddingHorizontal: tokens.spacing.md,
    paddingBottom: tokens.spacing.sm,
  },
  selectBody: {
    borderTopWidth: tokens.border.thin,
    borderTopColor: theme.colors.surfaceBorder,
    paddingVertical: 4,
  },
  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: tokens.spacing.sm,
    paddingHorizontal: tokens.spacing.md,
  },
  optionRowActive: { backgroundColor: theme.colors.primaryAlpha(0.12) },
  optionInfo: { flex: 1, marginRight: tokens.spacing.sm },
  optionText: { color: theme.colors.textMuted, fontSize: fonts.scaled(14) },
  optionTextActive: { color: theme.colors.text, fontWeight: '700' },
  optionMeta: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), marginTop: 2 },
});
