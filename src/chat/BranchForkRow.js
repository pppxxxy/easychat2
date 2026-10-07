// 分叉点入口：在「此处另有 N 条分支」的消息之后插入一条可展开的内联条。
// 收起时只有一行入口；展开后列出该分叉点的分支卡片（预览 + 时间），
// 每条卡片提供「切换到此」「删除分支」。纯展示组件，数据与操作由 ChatScreen 注入。

import React, { useState } from 'react';
import { ActivityIndicator, TouchableOpacity, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTranslation } from '../i18n/I18nContext.js';

function formatBranchTime(timestamp) {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) return '';
  const date = new Date(value);
  const pad = number => String(number).padStart(2, '0');
  return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function BranchForkRow({
  forkMessageId,
  branches,
  styles,
  theme,
  onCheckoutBranch,
  onDeleteBranch,
  checkoutDisabled,
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [busyId, setBusyId] = useState('');
  const count = Array.isArray(branches) ? branches.length : 0;
  if (count === 0) return null;
  const label = forkMessageId
    ? t('chat.branch.forkEntry', { count })
    : t('chat.branch.forkEntryRoot', { count });

  const handleCheckout = async branch => {
    if (busyId || checkoutDisabled || typeof onCheckoutBranch !== 'function') return;
    setBusyId(branch.id);
    try {
      await onCheckoutBranch(branch);
    } finally {
      setBusyId('');
    }
  };

  const handleDelete = async branch => {
    if (busyId || typeof onDeleteBranch !== 'function') return;
    setBusyId(branch.id);
    try {
      await onDeleteBranch(branch);
    } finally {
      setBusyId('');
    }
  };

  return (
    <View style={styles.branchForkWrap}>
      <TouchableOpacity
        style={styles.branchForkEntry}
        onPress={() => setExpanded(open => !open)}
        activeOpacity={0.8}
        accessibilityRole="button"
        accessibilityLabel={t('chat.branch.expandA11y')}
      >
        <Text style={styles.branchForkEntryText}>{label}</Text>
        <Ionicons
          name={expanded ? 'chevron-up' : 'chevron-down'}
          size={13}
          color={theme.colors.textFaint}
        />
      </TouchableOpacity>
      {expanded ? (
        <View style={styles.branchList}>
          {branches.map(branch => (
            <View key={branch.id} style={styles.branchCard}>
              <View style={styles.branchCardBody}>
                <Text style={styles.branchCardPreview} numberOfLines={2}>
                  {branch.preview || t('chat.branch.emptyPreview')}
                </Text>
                <Text style={styles.branchCardMeta}>
                  {t('chat.branch.countMeta', { count: Number(branch.messageCount) || 0 })}
                  {formatBranchTime(branch.createdAt) ? ` · ${formatBranchTime(branch.createdAt)}` : ''}
                </Text>
              </View>
              <View style={styles.branchCardActions}>
                <TouchableOpacity
                  style={[styles.branchActionButton, checkoutDisabled && styles.branchActionDisabled]}
                  onPress={() => handleCheckout(branch)}
                  disabled={checkoutDisabled || busyId === branch.id}
                  activeOpacity={0.8}
                >
                  {busyId === branch.id ? (
                    <ActivityIndicator size="small" color={theme.colors.primarySoft} />
                  ) : (
                    <Text style={styles.branchActionText}>{t('chat.branch.checkout')}</Text>
                  )}
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.branchDeleteButton}
                  onPress={() => handleDelete(branch)}
                  disabled={busyId === branch.id}
                  activeOpacity={0.8}
                  accessibilityLabel={t('chat.branch.delete')}
                >
                  <Ionicons name="trash-outline" size={15} color={theme.colors.danger} />
                </TouchableOpacity>
              </View>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

export default BranchForkRow;
