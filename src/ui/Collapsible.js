import React, { useMemo, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme } from '../theme/ThemeContext.js';
import { useTranslation } from '../i18n/I18nContext.js';

// 折叠分组：标题行点击展开/收起内容。用于设置页把体积较大的区块（外观、生成参数等）
// 默认收起，避免一屏塞满选项。可受控（open + onToggle）或非受控（defaultOpen）。
//
// 2026-10-05 合并：原 src/character/editors.js 另有一套参数不兼容的 CollapsibleSection
// （expanded + count 徽章 + onAdd 按钮 + 自己的卡片边框）。两套合并到这里——props 取并集，
// 视觉沿用本组件（设置页语言）：收起时右侧给摘要（count 或 right 插槽），
// onAdd 存在时在内容底部渲染添加按钮。这样角色详情页的分组不再在 Card 里再套一层
// 带边框的卡片（框中框），层级由缩进与间距表达。
//
// 迁移对照：editors 版的 `expanded` → 本组件 `open`；`count`/`onAdd`/`addLabel` 同名沿用。
export function CollapsibleSection({
  title,
  icon,
  defaultOpen = false,
  open,
  onToggle,
  right,
  count,
  onAdd,
  addLabel,
  children,
  style,
}) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const [innerOpen, setInnerOpen] = useState(defaultOpen);
  const expanded = open === undefined ? innerOpen : open === true;
  const toggle = () => {
    if (open === undefined) setInnerOpen(v => !v);
    if (onToggle) onToggle(!expanded);
  };
  const hasCount = count !== undefined && count !== null && count !== '';
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
          <Text style={[styles.headTitle, icon ? styles.headTitleSpaced : null]} numberOfLines={1}>
            {title}
          </Text>
        </View>
        <View style={styles.headRight}>
          {right}
          {/* 摘要位：count 与 right 可同时存在（count 在前，贴近标题对应的计数语义） */}
          {hasCount ? (
            <View style={styles.countBadge}>
              <Text style={styles.countBadgeText}>{count}</Text>
            </View>
          ) : null}
          <Ionicons
            name={expanded ? 'chevron-up' : 'chevron-down'}
            size={16}
            color={theme.colors.textFaint}
            style={styles.headChevron}
          />
        </View>
      </TouchableOpacity>
      {expanded ? (
        <View style={styles.body}>
          {children}
          {onAdd ? (
            <TouchableOpacity style={styles.addButton} onPress={onAdd} activeOpacity={0.8}>
              <Ionicons name="add" size={16} color={theme.colors.primarySoft} />
              <Text style={styles.addButtonText}>{addLabel}</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}
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
  placeholder,
  emptyHint,
  right,
  style,
}) {
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
  const resolvedPlaceholder = placeholder !== undefined ? placeholder : t('ui.select.none');
  const resolvedEmptyHint = emptyHint !== undefined ? emptyHint : t('ui.select.empty');
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
            {displayLabel || resolvedPlaceholder}
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
          <Text style={styles.selectEmpty}>{resolvedEmptyHint}</Text>
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
  // 右侧插槽参与收缩协商：headLeft 可缩 + headRight 可缩 + 摘要文本可缩，
  // 长摘要（如长 API 名）才推不动按钮、挤不出屏幕（2026-10-07 API 行溢出修复）。
  headRight: { flexDirection: 'row', alignItems: 'center', flexShrink: 1 },
  // 折叠箭头与右侧插槽之间保底间距：摘要很短时按钮不贴死箭头。
  headChevron: { marginLeft: 6 },
  body: { marginTop: tokens.spacing.xs },
  // 摘要徽章（原 editors 版的 count 徽章）：数字或短文本都适用
  countBadge: {
    minWidth: 22,
    paddingHorizontal: 7,
    paddingVertical: 1,
    borderRadius: tokens.radius.pill,
    backgroundColor: theme.colors.primaryAlpha(0.16),
    alignItems: 'center',
    marginRight: 8,
  },
  countBadgeText: { color: theme.colors.primarySoft, fontSize: fonts.scaled(11), fontWeight: '700' },
  // 折叠区底部的添加按钮（原 editors 版的 onAdd/addLabel）
  addButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.primaryMutedAlpha(0.45),
    borderRadius: tokens.radius.md,
    paddingVertical: 8,
    marginTop: 8,
  },
  addButtonText: { color: theme.colors.primarySoft, fontSize: fonts.scaled(12), fontWeight: '700', marginLeft: 4 },

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
