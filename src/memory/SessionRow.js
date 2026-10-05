// 会话行：记忆页管理行 / 聊天页切换器行 / 搜索结果行共用同一套视觉语言。
// 纯展示组件——数据（名称/预览/时间/头像）由调用方装配，本组件不读存储。
// 头像的三种形态（单聊图 / 首字兜底 / 群三叠图）由 SessionAvatar 统一封装，
// 此前 MemoryScreen 与 SwitcherModal 各写了一份（2026-10-06 指令书 Phase 1）。

import React, { useMemo } from 'react';
import { Image, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme } from '../theme/ThemeContext.js';

// 相对时间：今天显示时分，昨天显示「昨天」，更早显示「M月D日」。
// 原 MemoryScreen 内联实现，提到这里供三处复用。
export function formatSessionTime(timestamp) {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) return '';
  const date = new Date(value);
  const now = new Date();
  const pad = number => String(number).padStart(2, '0');
  if (date.toDateString() === now.toDateString()) {
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return '昨天';
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

export function SessionAvatar({ isGroup = false, uri = '', name = '', members = [], size = 44 }) {
  const { theme, fonts } = useTheme();
  const styles = useMemo(() => createAvatarStyles(theme, fonts), [theme, fonts]);
  const radius = Math.round(size * 0.28);
  const boxStyle = { width: size, height: size, borderRadius: radius };
  if (isGroup) {
    if (uri) {
      return <Image source={{ uri }} style={[styles.avatar, boxStyle]} />;
    }
    const list = (Array.isArray(members) ? members : []).filter(Boolean).slice(0, 3);
    // 群聊拿不到成员列表时（如搜索结果只带 sessionType）：退化为人群图标，
    // 与切换器既有的群兜底视觉一致。
    if (list.length === 0) {
      return (
        <View style={[styles.avatar, styles.fallback, boxStyle]}>
          <Ionicons name="people" size={Math.round(size * 0.38)} color={theme.colors.primarySoft} />
        </View>
      );
    }
    const itemSize = Math.round(size * 0.7);
    const itemRadius = Math.round(itemSize * 0.22);
    const offset = Math.round(size * 0.25);
    return (
      <View style={{ width: size, height: size }}>
        {list.map((member, index) => (
          member.avatarUri ? (
            <Image
              key={member.id || index}
              source={{ uri: member.avatarUri }}
              style={[styles.groupItem, {
                width: itemSize,
                height: itemSize,
                borderRadius: itemRadius,
                left: index * offset,
              }]}
            />
          ) : (
            <View
              key={member.id || index}
              style={[styles.groupItem, styles.fallback, {
                width: itemSize,
                height: itemSize,
                borderRadius: itemRadius,
                left: index * offset,
              }]}
            >
              <Text style={styles.groupItemText}>{String(member.name || '?').charAt(0)}</Text>
            </View>
          )
        ))}
      </View>
    );
  }
  if (uri) {
    return <Image source={{ uri }} style={[styles.avatar, boxStyle]} />;
  }
  return (
    <View style={[styles.avatar, styles.fallback, boxStyle]}>
      <Text style={[styles.fallbackText, { fontSize: fonts.scaled(Math.round(size * 0.38)) }]}>
        {String(name || '?').charAt(0)}
      </Text>
    </View>
  );
}

// mode:
//   manage —— 记忆页：单行预览 + 右上时间，长按出操作单（置顶/克隆/删除）
//   switch —— 聊天页切换器：active 显示对勾，行更紧凑
//   result —— 搜索结果：预览两行（关键词摘录需要更多上下文）
export default function SessionRow({
  avatar,
  name,
  badges = [],
  pinned = false,
  preview = '',
  time = '',
  mode = 'manage',
  active = false,
  selectable = false,
  selected = false,
  onPress,
  onLongPress,
}) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createRowStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const previewLines = mode === 'result' ? 2 : 1;
  const shownBadges = (Array.isArray(badges) ? badges : [])
    .filter(badge => badge && badge.text)
    .slice(0, 2);
  return (
    <TouchableOpacity
      style={[
        styles.row,
        mode === 'switch' && styles.rowCompact,
        selected && styles.rowSelected,
      ]}
      activeOpacity={0.72}
      onPress={onPress}
      onLongPress={typeof onLongPress === 'function' ? onLongPress : undefined}
      delayLongPress={320}
      accessibilityRole="button"
      accessibilityLabel={String(name || '')}
    >
      {selectable ? (
        <Ionicons
          name={selected ? 'checkbox' : 'square-outline'}
          size={22}
          color={selected ? theme.colors.primaryMuted : theme.colors.textFaint}
          style={styles.checkbox}
        />
      ) : null}
      {avatar}
      <View style={styles.body}>
        <View style={styles.nameRow}>
          <Text style={styles.name} numberOfLines={1}>{name}</Text>
          {shownBadges.map((badge, index) => (
            <View key={`${badge.text}-${index}`} style={styles.badge}>
              {badge.icon ? (
                <Ionicons
                  name={badge.icon}
                  size={10}
                  color={theme.colors.primarySoft}
                  style={styles.badgeIcon}
                />
              ) : null}
              <Text style={styles.badgeText}>{badge.text}</Text>
            </View>
          ))}
          {pinned ? (
            <Ionicons name="star" size={12} color={theme.colors.star} style={styles.pin} />
          ) : null}
          <View style={styles.nameSpacer} />
          {time ? <Text style={styles.time}>{time}</Text> : null}
        </View>
        {preview ? (
          <Text style={styles.preview} numberOfLines={previewLines}>{preview}</Text>
        ) : null}
      </View>
      {active ? (
        <Ionicons
          name="checkmark-circle"
          size={18}
          color={theme.colors.primary}
          style={styles.check}
        />
      ) : null}
    </TouchableOpacity>
  );
}

const createAvatarStyles = (theme, fonts) => StyleSheet.create({
  avatar: { backgroundColor: theme.colors.surfaceBorder },
  fallback: { alignItems: 'center', justifyContent: 'center' },
  fallbackText: { color: theme.colors.textMuted, fontWeight: '700' },
  groupItem: {
    position: 'absolute',
    top: 0,
    backgroundColor: theme.colors.surfaceBorder,
    borderWidth: 1,
    borderColor: theme.colors.surfaceAlt,
  },
  groupItemText: { color: theme.colors.textMuted, fontSize: fonts.scaled(13), fontWeight: '700' },
});

const createRowStyles = (theme, fonts, tokens) => StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 4,
    borderRadius: tokens.radius.md,
  },
  rowCompact: { paddingVertical: 7 },
  rowSelected: { backgroundColor: theme.colors.primaryAlpha(0.08) },
  checkbox: { marginRight: 10 },
  body: { flex: 1, marginLeft: 12 },
  nameRow: { flexDirection: 'row', alignItems: 'center' },
  name: {
    color: theme.colors.text,
    fontSize: fonts.scaled(15),
    fontWeight: '700',
    flexShrink: 1,
  },
  badge: {
    marginLeft: 6,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.primaryAlpha(0.16),
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.primaryMutedAlpha(0.35),
    borderRadius: tokens.radius.pill,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  badgeIcon: { marginRight: 2 },
  badgeText: {
    color: theme.colors.primarySoft,
    fontSize: fonts.scaled(10),
    fontWeight: '700',
  },
  pin: { marginLeft: 6 },
  nameSpacer: { flex: 1 },
  time: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), marginLeft: 8 },
  preview: {
    color: theme.colors.textMuted,
    fontSize: fonts.scaled(13),
    lineHeight: fonts.scaled(19),
    marginTop: 3,
  },
  check: { marginLeft: 8 },
});
