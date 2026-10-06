import React from 'react';
import { Alert, Switch, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import CollapsibleHint from '../CollapsibleHint.js';

export default function ExperienceSection(props) {
  const {
    styles,
    theme,
    t,
    setPresetEntryOpen,
    enabledPresetCount,
    chatOptions,
    updateChatOption,
    locationSettings,
    toggleLocationAwareness,
    momentsEnabled,
    toggleMoments,
  } = props;
  return (
    <>
          <TouchableOpacity
            style={styles.linkRow}
            onPress={() => setPresetEntryOpen(true)}
            activeOpacity={0.7}
          >
            <View style={styles.linkLeft}>
              <Ionicons name="list-outline" size={17} color={theme.colors.primaryMuted} />
              <Text style={styles.linkText}>{t('settings.global.presets')}</Text>
            </View>
            <View style={styles.linkRight}>
              <Text style={styles.linkValue}>
                {enabledPresetCount > 0 ? t('settings.global.presetCount', { count: enabledPresetCount }) : t('settings.global.presetDisabled')}
              </Text>
              <Ionicons name="chevron-forward" size={16} color={theme.colors.primary} />
            </View>
          </TouchableOpacity>
          <View style={styles.capabilityRow}>
            <View style={styles.linkLeft}>
              <Ionicons name="pulse-outline" size={17} color={theme.colors.primaryMuted} />
              <Text style={styles.linkText}>{t('settings.global.streaming')}</Text>
            </View>
            <Switch
              value={chatOptions.streaming}
              onValueChange={value => updateChatOption('streaming', value)}
              trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
              thumbColor={theme.colors.primaryContrast}
            />
          </View>
          <View style={styles.capabilityRow}>
            <View style={styles.linkLeft}>
              <Ionicons name="resize-outline" size={17} color={theme.colors.primaryMuted} />
              <Text style={styles.linkText}>{t('settings.global.fullWidth')}</Text>
            </View>
            <Switch
              value={chatOptions.fullWidth}
              onValueChange={value => {
                // 开启前提醒：全宽气泡下部分角色卡的排版会引发横向滑动/滚动手势异常，
                // 用户确认后才落盘；关闭不需要确认。
                if (!value) {
                  updateChatOption('fullWidth', false);
                  return;
                }
                Alert.alert(
                  t('settings.experience.fullWidth.title'),
                  t('settings.experience.fullWidth.body'),
                  [
                    { text: t('common.cancel'), style: 'cancel' },
                    { text: t('settings.experience.fullWidth.confirm'), onPress: () => updateChatOption('fullWidth', true) },
                  ]
                );
              }}
              trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
              thumbColor={theme.colors.primaryContrast}
            />
          </View>
          <View style={styles.capabilityRow}>
            <View style={styles.linkLeft}>
              <Ionicons name="code-slash-outline" size={17} color={theme.colors.primaryMuted} />
              <Text style={styles.linkText}>{t('settings.global.richHtml')}</Text>
            </View>
            <Switch
              value={chatOptions.richHtml !== false}
              onValueChange={value => updateChatOption('richHtml', value)}
              trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
              thumbColor={theme.colors.primaryContrast}
            />
          </View>
          <CollapsibleHint>{t('settings.global.richHtmlHint')}</CollapsibleHint>
          <View style={styles.capabilityRow}>
            <View style={styles.linkLeft}>
              <Ionicons name="save-outline" size={17} color={theme.colors.primaryMuted} />
              <Text style={styles.linkText}>{t('settings.global.keepDraft')}</Text>
            </View>
            <Switch
              value={chatOptions.keepDraft === true}
              onValueChange={value => updateChatOption('keepDraft', value)}
              trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
              thumbColor={theme.colors.primaryContrast}
            />
          </View>
          <CollapsibleHint>{t('settings.global.keepDraftHint')}</CollapsibleHint>
          <View style={styles.capabilityRow}>
            <View style={styles.linkLeft}>
              <Ionicons name="time-outline" size={17} color={theme.colors.primaryMuted} />
              <Text style={styles.linkText}>{t('settings.global.timeAware')}</Text>
            </View>
            <Switch
              value={chatOptions.timeAware === true}
              onValueChange={value => updateChatOption('timeAware', value)}
              trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
              thumbColor={theme.colors.primaryContrast}
            />
          </View>
          <CollapsibleHint>{t('settings.global.timeAwareHint')}</CollapsibleHint>
          {locationSettings && locationSettings.enabled === true ? (
            <>
              <View style={styles.capabilityRow}>
                <View style={styles.linkLeft}>
                  <Ionicons name="navigate-outline" size={17} color={theme.colors.primaryMuted} />
                  <Text style={styles.linkText}>{t('settings.location.awareness.title')}</Text>
                </View>
                <Switch
                  value={locationSettings.awareness === true}
                  onValueChange={toggleLocationAwareness}
                  trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
                  thumbColor={theme.colors.primaryContrast}
                />
              </View>
              <CollapsibleHint>{t('settings.location.awareness.hint')}</CollapsibleHint>
            </>
          ) : null}
          <View style={styles.capabilityRow}>
            <View style={styles.linkLeft}>
              <Ionicons name="planet-outline" size={17} color={theme.colors.primaryMuted} />
              <Text style={styles.linkText}>{t('settings.global.moments')}</Text>
            </View>
            <Switch
              value={momentsEnabled}
              onValueChange={toggleMoments}
              trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
              thumbColor={theme.colors.primaryContrast}
            />
          </View>
    </>
  );
}
