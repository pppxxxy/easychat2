import React, { useState } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { FieldLabel } from '../../ui/index.js';
import { hexToRgba, getTheme, CUSTOM_THEME_ID } from '../../theme/themes.js';
import { BUBBLE_STYLES } from '../../theme/themes.js';
import { THINKING_DISPLAYS } from '../../storage/settings.js';
import { useTheme } from '../../theme/ThemeContext.js';
import CustomThemeModal from '../CustomThemeModal.js';
import CollapsibleHint from '../CollapsibleHint.js';

export default function AppearanceSection(props) {
  const {
    styles,
    theme,
    t,
    themes,
    themeId,
    setThemeId,
    fontScales,
    fontScaleId,
    setFontScaleId,
    thinkingDisplay,
    updateThinkingDisplay,
    chatOptions,
    updateChatOption,
  } = props;
  // 自定义配色由主题 Context 持有，这里直接取用——不必再穿一层 sectionProps，
  // 也避免设置页宿主为了一个编辑器弹层多挂一份状态。
  const { customColors, setCustomColors } = useTheme();
  const [customThemeOpen, setCustomThemeOpen] = useState(false);
  // 自定义主题的芯片色块要显示用户「实际在用」的配色，而不是出厂底稿——
  // 否则改完颜色回来看芯片还是灰的，会以为没保存上。
  const customSwatch = getTheme(CUSTOM_THEME_ID, customColors).colors;
  // 起稿点：还没存过自定义配色时以「当前主题」为起点——用户点开编辑多半是想微调正在用的
  // 那套配色，而不是对着一块中性底稿从零重建；存过之后继续编辑已存的那份。
  const customDraftSeed = Object.keys(customColors).length > 0 ? customColors : theme.colors;
  // 保存即应用：setCustomColors 会同时把主题切到「自定义」并落盘。
  const saveCustomTheme = colors => {
    setCustomColors(colors);
    setCustomThemeOpen(false);
  };
  return (
    <>
            <View style={styles.appearanceRow}>
              {themes.map(item => {
                const active = item.id === themeId;
                const swatch = item.id === CUSTOM_THEME_ID ? customSwatch : item.colors;
                return (
                  <TouchableOpacity
                    key={item.id}
                    style={[styles.themeChip, active && {
                      borderColor: swatch.primary,
                      backgroundColor: hexToRgba(swatch.primary, 0.08),
                    }]}
                    onPress={() => setThemeId(item.id)}
                    activeOpacity={0.85}
                    accessibilityLabel={t('settings.appearance.switchTheme', { name: t(item.labelKey) })}
                  >
                    <View style={[styles.themeSwatch, { backgroundColor: swatch.background }]}>
                      <View style={[styles.themeSwatchDot, { backgroundColor: swatch.primary }]} />
                    </View>
                    <Text style={[styles.themeChipText, active && { color: swatch.primary, fontWeight: '800' }]}>
                      {t(item.labelKey)}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <View style={styles.thinkingDisplayRow}>
              <View style={styles.linkLeft}>
                <Ionicons name="options-outline" size={17} color={theme.colors.primaryMuted} />
                <Text style={styles.linkText}>{t('settings.appearance.customTheme')}</Text>
              </View>
              <View style={styles.thinkingDisplayChips}>
                <TouchableOpacity
                  style={[styles.formatChip, themeId === CUSTOM_THEME_ID && styles.formatChipActive]}
                  onPress={() => setCustomThemeOpen(true)}
                  activeOpacity={0.8}
                  accessibilityRole="button"
                  accessibilityLabel={t('settings.appearance.customTheme.open')}
                >
                  <Text style={[styles.formatChipText, themeId === CUSTOM_THEME_ID && styles.formatChipTextActive]}>
                    {t('settings.appearance.customTheme.open')}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
            <CollapsibleHint>{t('settings.appearance.customThemeHint')}</CollapsibleHint>
            <FieldLabel style={styles.label}>{t('settings.appearance.fontScale')}</FieldLabel>
            <View style={styles.fontRow}>
              {fontScales.map(item => {
                const active = item.id === fontScaleId;
                return (
                  <TouchableOpacity
                    key={item.id}
                    style={[styles.fontChip, active && styles.fontChipActive]}
                    onPress={() => setFontScaleId(item.id)}
                    activeOpacity={0.85}
                  >
                    <Text style={[styles.fontChipText, active && styles.fontChipTextActive]}>
                      {t(item.labelKey)}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <View style={styles.thinkingDisplayRow}>
              <View style={styles.linkLeft}>
                <Ionicons name="bulb-outline" size={17} color={theme.colors.primaryMuted} />
                <Text style={styles.linkText}>{t('settings.global.thinkingDisplay')}</Text>
              </View>
              <View style={styles.thinkingDisplayChips}>
                {THINKING_DISPLAYS.map(display => {
                  const active = thinkingDisplay === display;
                  const label = display === 'open'
                    ? t('settings.global.thinkingDisplay.open')
                    : display === 'fold'
                      ? t('settings.global.thinkingDisplay.fold')
                      : t('settings.global.thinkingDisplay.closed');
                  return (
                    <TouchableOpacity
                      key={display}
                      style={[styles.formatChip, active && styles.formatChipActive]}
                      onPress={() => updateThinkingDisplay(display)}
                      activeOpacity={0.8}
                    >
                      <Text style={[styles.formatChipText, active && styles.formatChipTextActive]}>
                        {label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
            <View style={styles.thinkingDisplayRow}>
              <View style={styles.linkLeft}>
                <Ionicons name="chatbubbles-outline" size={17} color={theme.colors.primaryMuted} />
                <Text style={styles.linkText}>{t('settings.global.bubbleStyle')}</Text>
              </View>
              <View style={styles.thinkingDisplayChips}>
                {BUBBLE_STYLES.map(style => {
                  const active = (chatOptions.bubbleStyle || 'rounded') === style;
                  const label = style === 'rounded'
                    ? t('settings.global.bubble.rounded')
                    : style === 'card'
                      ? t('settings.global.bubble.card')
                      : t('settings.global.bubble.plain');
                  return (
                    <TouchableOpacity
                      key={style}
                      style={[styles.formatChip, active && styles.formatChipActive]}
                      onPress={() => updateChatOption('bubbleStyle', style)}
                      activeOpacity={0.8}
                    >
                      <Text style={[styles.formatChipText, active && styles.formatChipTextActive]}>
                        {label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
            <CollapsibleHint>{t('settings.global.bubbleHint')}</CollapsibleHint>
            <CustomThemeModal
              visible={customThemeOpen}
              colors={customDraftSeed}
              onSave={saveCustomTheme}
              onClose={() => setCustomThemeOpen(false)}
            />
    </>
  );
}
