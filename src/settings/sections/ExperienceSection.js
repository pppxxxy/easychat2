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
              <Text style={styles.linkText}>全局预设 / 记忆总结</Text>
            </View>
            <View style={styles.linkRight}>
              <Text style={styles.linkValue}>
                {enabledPresetCount > 0 ? `文本预设 ${enabledPresetCount} 项` : '文本预设未开启'}
              </Text>
              <Ionicons name="chevron-forward" size={16} color={theme.colors.primary} />
            </View>
          </TouchableOpacity>
          <View style={styles.capabilityRow}>
            <View style={styles.linkLeft}>
              <Ionicons name="pulse-outline" size={17} color={theme.colors.primaryMuted} />
              <Text style={styles.linkText}>流式输出</Text>
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
              <Text style={styles.linkText}>全宽对话</Text>
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
              <Text style={styles.linkText}>富 HTML 渲染</Text>
            </View>
            <Switch
              value={chatOptions.richHtml !== false}
              onValueChange={value => updateChatOption('richHtml', value)}
              trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
              thumbColor={theme.colors.primaryContrast}
            />
          </View>
          <CollapsibleHint>{'开启后，含 <style>/<script> 的助手消息用 WebView 渲染，可还原角色卡的样式与交互；折叠状态栏始终保留 WebView 渲染。'}</CollapsibleHint>
          <View style={styles.capabilityRow}>
            <View style={styles.linkLeft}>
              <Ionicons name="save-outline" size={17} color={theme.colors.primaryMuted} />
              <Text style={styles.linkText}>保留输入草稿</Text>
            </View>
            <Switch
              value={chatOptions.keepDraft === true}
              onValueChange={value => updateChatOption('keepDraft', value)}
              trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
              thumbColor={theme.colors.primaryContrast}
            />
          </View>
          <CollapsibleHint>开启后，退出或切换角色时会记住输入框里还没发出去的文字，下次回到这个对话自动填回；关闭则每次进入都清空。</CollapsibleHint>
          <View style={styles.capabilityRow}>
            <View style={styles.linkLeft}>
              <Ionicons name="time-outline" size={17} color={theme.colors.primaryMuted} />
              <Text style={styles.linkText}>时间感知</Text>
            </View>
            <Switch
              value={chatOptions.timeAware === true}
              onValueChange={value => updateChatOption('timeAware', value)}
              trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
              thumbColor={theme.colors.primaryContrast}
            />
          </View>
          <CollapsibleHint>开启后，每次对话都会把「当前的日期与时间」告诉角色，让它知道现在是几点、星期几；关闭则角色不感知时间。默认关闭。</CollapsibleHint>
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
              <Text style={styles.linkText}>动态</Text>
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
