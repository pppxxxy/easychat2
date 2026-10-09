// 批量上锁 · 第一步：多选角色（支持全选 / 全不选）。
// 与第二步的 PinModal（统一设密码 + 提示）配合；本步只管选人，不碰存储。
// 状态自持（useTheme/useTranslation 自取），调用方只需给数据与回调——
// 避免出现「声明了 t/styles 却漏传」那类渲染即崩的接线缺口。

import React, { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme } from '../../theme/ThemeContext.js';
import { useTranslation } from '../../i18n/I18nContext.js';

export default function BulkLockPickerModal({
  visible,
  characters,
  locks,
  onConfirm,
  onClose,
}) {
  const { t } = useTranslation();
  const { theme, fonts, tokens } = useTheme();
  const styles = createStyles(theme, fonts, tokens);
  const [selected, setSelected] = useState(() => new Set());

  // 每次打开都从零开始选：残留的上次勾选最容易让人误锁一批角色。
  useEffect(() => {
    if (visible) setSelected(new Set());
  }, [visible]);

  const list = Array.isArray(characters) ? characters : [];
  const lockMap = locks && typeof locks === 'object' ? locks : {};
  const allSelected = list.length > 0 && selected.size >= list.length;

  const toggle = id => {
    setSelected(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(list.map(item => item.id)));
  };

  const confirm = () => {
    const ids = list.map(item => item.id).filter(id => selected.has(id));
    if (ids.length === 0) return;
    if (typeof onConfirm === 'function') onConfirm(ids);
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <Text style={styles.title}>{t('settings.security.bulk.title')}</Text>
          <Text style={styles.subtitle}>{t('settings.security.bulk.hint')}</Text>

          <View style={styles.toolbar}>
            <TouchableOpacity
              style={styles.selectAllButton}
              onPress={toggleAll}
              activeOpacity={0.8}
              accessibilityRole="button"
              accessibilityLabel={allSelected ? t('settings.security.bulk.clearAll') : t('settings.security.bulk.selectAll')}
            >
              <Ionicons
                name={allSelected ? 'checkbox-outline' : 'square-outline'}
                size={16}
                color={theme.colors.primary}
              />
              <Text style={styles.selectAllText}>
                {allSelected ? t('settings.security.bulk.clearAll') : t('settings.security.bulk.selectAll')}
              </Text>
            </TouchableOpacity>
            <Text style={styles.countText}>
              {t('settings.security.bulk.selected', { count: selected.size })}
            </Text>
          </View>

          <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
            {list.map(item => {
              const checked = selected.has(item.id);
              const locked = lockMap[item.id] === true;
              return (
                <TouchableOpacity
                  key={item.id}
                  style={styles.row}
                  onPress={() => toggle(item.id)}
                  activeOpacity={0.7}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked }}
                  accessibilityLabel={item.name || item.id}
                >
                  <Ionicons
                    name={checked ? 'checkbox' : 'square-outline'}
                    size={19}
                    color={checked ? theme.colors.primary : theme.colors.textFaint}
                  />
                  <Text style={styles.rowName} numberOfLines={1}>{item.name || item.id}</Text>
                  {locked ? (
                    <View style={styles.lockedBadge}>
                      <Ionicons name="lock-closed" size={11} color={theme.colors.primary} />
                      <Text style={styles.lockedBadgeText}>{t('settings.security.bulk.locked')}</Text>
                    </View>
                  ) : null}
                </TouchableOpacity>
              );
            })}
          </ScrollView>

          <View style={styles.actions}>
            <TouchableOpacity
              style={[styles.button, styles.ghostButton]}
              onPress={onClose}
              activeOpacity={0.8}
            >
              <Text style={styles.buttonText}>{t('common.cancel')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.button, styles.primaryButton, selected.size === 0 && styles.buttonDisabled]}
              onPress={confirm}
              disabled={selected.size === 0}
              activeOpacity={0.85}
            >
              <Text style={[styles.buttonText, styles.primaryButtonText]}>
                {t('settings.security.bulk.next')}
              </Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function createStyles(theme, fonts, tokens) {
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: theme.colors.overlay,
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
    },
    sheet: {
      width: '100%',
      maxWidth: 380,
      maxHeight: '82%',
      borderRadius: 18,
      padding: 20,
      backgroundColor: theme.colors.surface,
      borderWidth: 1,
      borderColor: theme.colors.surfaceBorder,
      ...tokens.elevation(3, theme),
    },
    title: {
      color: theme.colors.text,
      fontSize: fonts.scaled(17),
      fontWeight: '800',
    },
    subtitle: {
      color: theme.colors.textMuted,
      fontSize: fonts.scaled(12),
      lineHeight: fonts.scaled(18),
      marginTop: 6,
    },
    toolbar: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginTop: 14,
      paddingBottom: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.surfaceBorder,
    },
    selectAllButton: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    selectAllText: {
      color: theme.colors.primary,
      fontSize: fonts.scaled(13),
      fontWeight: '700',
    },
    countText: {
      color: theme.colors.textFaint,
      fontSize: fonts.scaled(12),
    },
    list: {
      marginTop: 4,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      paddingVertical: 11,
    },
    rowName: {
      flex: 1,
      color: theme.colors.text,
      fontSize: fonts.scaled(14),
    },
    lockedBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 3,
      borderRadius: 8,
      paddingHorizontal: 6,
      paddingVertical: 2,
      backgroundColor: theme.colors.surfaceAlt,
      borderWidth: 1,
      borderColor: theme.colors.surfaceBorder,
    },
    lockedBadgeText: {
      color: theme.colors.primary,
      fontSize: fonts.scaled(10),
      fontWeight: '700',
    },
    actions: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      marginTop: 14,
      gap: 10,
    },
    button: {
      minWidth: 92,
      borderRadius: 12,
      paddingVertical: 11,
      paddingHorizontal: 16,
      alignItems: 'center',
      justifyContent: 'center',
    },
    ghostButton: {
      backgroundColor: theme.colors.surfaceAlt,
      borderWidth: 1,
      borderColor: theme.colors.surfaceBorder,
    },
    primaryButton: {
      backgroundColor: theme.colors.primary,
    },
    buttonDisabled: {
      opacity: 0.6,
    },
    buttonText: {
      color: theme.colors.text,
      fontSize: fonts.scaled(14),
      fontWeight: '700',
    },
    primaryButtonText: {
      color: theme.colors.primaryContrast,
    },
  });
}
