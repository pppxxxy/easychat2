// 紧凑的「版本切换器」：助手气泡右下角的 `< N///M >`。
// 版本按时间旧→新编号，当前版本显示其序号；到首/末版本时对应箭头置灰。
// 纯展示组件，数据与操作由上层注入（见 MessageList / MessageBubble）。

import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';

import { useTranslation } from '../i18n/I18nContext.js';

function BranchSwitcher({
  index,
  total,
  hasPrev,
  hasNext,
  onPrev,
  onNext,
  disabled,
  styles,
}) {
  const { t } = useTranslation();
  if (!(Number(total) > 1)) return null;
  const prevDisabled = !!disabled || !hasPrev;
  const nextDisabled = !!disabled || !hasNext;
  return (
    <View style={styles.branchSwitcher}>
      <TouchableOpacity
        onPress={prevDisabled ? undefined : onPrev}
        disabled={prevDisabled}
        hitSlop={8}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel={t('chat.branch.prevA11y')}
      >
        <Text style={[styles.branchSwitcherArrow, prevDisabled && styles.branchSwitcherArrowDisabled]}>{'<'}</Text>
      </TouchableOpacity>
      <Text style={styles.branchSwitcherLabel}>{`${index}///${total}`}</Text>
      <TouchableOpacity
        onPress={nextDisabled ? undefined : onNext}
        disabled={nextDisabled}
        hitSlop={8}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel={t('chat.branch.nextA11y')}
      >
        <Text style={[styles.branchSwitcherArrow, nextDisabled && styles.branchSwitcherArrowDisabled]}>{'>'}</Text>
      </TouchableOpacity>
    </View>
  );
}

export default BranchSwitcher;
