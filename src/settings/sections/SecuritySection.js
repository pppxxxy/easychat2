import React from 'react';
import { Switch, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import CollapsibleHint from '../CollapsibleHint.js';

// 设置页「隐私与安全」卡：应用锁（生物识别）+ 角色锁（数字密码）展示区。
// 状态与保存逻辑在 SettingsScreen，本卡只做展示与回调转发。
export default function SecuritySection(props) {
  const {
    styles,
    theme,
    t,
    securityLoaded,
    appLockSettings,
    biometricAvailability,
    characterLocks,
    characters,
    toggleAppLock,
    toggleRelockOnBackground,
    toggleCharacterLock,
    onBulkLock,
    onShowHint,
  } = props;

  const list = Array.isArray(characters) ? characters : [];
  const biometricUnavailable = !!(biometricAvailability && biometricAvailability.available === false);
  const appLockOn = appLockSettings && appLockSettings.enabled === true;

  return (
    <>
      <View style={styles.capabilityRow}>
        <View style={styles.linkLeft}>
          <Ionicons name="finger-print-outline" size={17} color={theme.colors.primaryMuted} />
          <Text style={styles.linkText}>{t('settings.security.appLock')}</Text>
        </View>
        <Switch
          value={appLockOn}
          onValueChange={toggleAppLock}
          disabled={!securityLoaded || biometricUnavailable}
          trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
          thumbColor={theme.colors.primaryContrast}
        />
      </View>
      <CollapsibleHint>{t('settings.security.appLockHint')}</CollapsibleHint>
      {biometricUnavailable ? (
        <CollapsibleHint>{t('settings.security.appLockUnavailable')}</CollapsibleHint>
      ) : null}
      {appLockOn ? (
        <>
          <View style={styles.capabilityRow}>
            <View style={styles.linkLeft}>
              <Ionicons name="refresh-outline" size={17} color={theme.colors.primaryMuted} />
              <Text style={styles.linkText}>{t('settings.security.relock')}</Text>
            </View>
            <Switch
              value={appLockSettings.relockOnBackground === true}
              onValueChange={toggleRelockOnBackground}
              trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
              thumbColor={theme.colors.primaryContrast}
            />
          </View>
          <CollapsibleHint>{t('settings.security.relockHint')}</CollapsibleHint>
        </>
      ) : null}

      <Text style={styles.label}>{t('settings.security.characterLocks')}</Text>
      <CollapsibleHint>{t('settings.security.characterLocksHint')}</CollapsibleHint>
      {/* 批量上锁：多选 / 全选后统一设一个密码（单个角色的设置仍在下面逐行点）。 */}
      <TouchableOpacity
        style={styles.capabilityRow}
        onPress={onBulkLock}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel={t('settings.security.bulkLock')}
      >
        <View style={styles.linkLeft}>
          <Ionicons name="lock-closed-outline" size={17} color={theme.colors.primaryMuted} />
          <Text style={styles.linkText}>{t('settings.security.bulkLock')}</Text>
        </View>
        <Ionicons name="chevron-forward" size={16} color={theme.colors.primary} />
      </TouchableOpacity>
      {list.map(item => {
        const locked = characterLocks[item.id] === true;
        return (
          <TouchableOpacity
            key={item.id}
            style={styles.capabilityRow}
            onPress={() => toggleCharacterLock(item)}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel={`${locked ? t('settings.security.locked') : t('settings.security.unlocked')} ${item.name || ''}`.trim()}
          >
            <View style={styles.linkLeft}>
              <Ionicons
                name={locked ? 'lock-closed' : 'lock-open-outline'}
                size={17}
                color={locked ? theme.colors.primary : theme.colors.primaryMuted}
              />
              <Text style={styles.linkText} numberOfLines={1}>{item.name || item.id}</Text>
            </View>
            {/* 已锁角色右上角的「提示」入口：忘记密码时点它看自己写的备忘。
                嵌套 TouchableOpacity 会先于父行捕获点击，不会误触发解锁流程。 */}
            {locked ? (
              <TouchableOpacity
                style={styles.hintButton}
                onPress={() => onShowHint(item)}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                accessibilityRole="button"
                accessibilityLabel={t('settings.security.hint.show', { name: item.name || '' })}
              >
                <Ionicons name="bulb-outline" size={17} color={theme.colors.primaryMuted} />
              </TouchableOpacity>
            ) : null}
            <Ionicons
              name={locked ? 'checkmark-circle' : 'ellipse-outline'}
              size={18}
              color={locked ? theme.colors.primary : theme.colors.textFaint}
            />
          </TouchableOpacity>
        );
      })}
    </>
  );
}
