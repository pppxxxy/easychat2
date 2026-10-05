import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { FieldLabel } from '../../ui/index.js';
import { hexToRgba } from '../../theme/themes.js';
import { BUBBLE_STYLES } from '../../theme/themes.js';
import { THINKING_DISPLAYS } from '../../storage.js';
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
    locales,
    localeId,
    setLocaleId,
    thinkingDisplay,
    updateThinkingDisplay,
    chatOptions,
    updateChatOption,
  } = props;
  return (
    <>
            <View style={styles.appearanceRow}>
              {themes.map(item => {
                const active = item.id === themeId;
                return (
                  <TouchableOpacity
                    key={item.id}
                    style={[styles.themeChip, active && {
                      borderColor: item.colors.primary,
                      backgroundColor: hexToRgba(item.colors.primary, 0.08),
                    }]}
                    onPress={() => setThemeId(item.id)}
                    activeOpacity={0.85}
                    accessibilityLabel={`切换到${item.label}主题`}
                  >
                    <View style={[styles.themeSwatch, { backgroundColor: item.colors.background }]}>
                      <View style={[styles.themeSwatchDot, { backgroundColor: item.colors.primary }]} />
                    </View>
                    <Text style={[styles.themeChipText, active && { color: item.colors.primary, fontWeight: '800' }]}>
                      {item.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <FieldLabel style={styles.label}>字体大小</FieldLabel>
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
                      {item.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <FieldLabel style={styles.label}>{t('settings.appearance.language')}</FieldLabel>
            <View style={styles.fontRow}>
              {locales.map(item => {
                const active = item.id === localeId;
                return (
                  <TouchableOpacity
                    key={item.id}
                    style={[styles.fontChip, active && styles.fontChipActive]}
                    onPress={() => setLocaleId(item.id)}
                    activeOpacity={0.85}
                    accessibilityLabel={item.english}
                  >
                    {/* 语言名用各自的写法展示：英文界面下「简体中文」仍显示为中文，
                        用户不必先读懂当前界面语言才能找到自己的语言。 */}
                    <Text style={[styles.fontChipText, active && styles.fontChipTextActive]}>
                      {item.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <FieldLabel style={styles.label}>聊天呈现</FieldLabel>
            <View style={styles.thinkingDisplayRow}>
              <View style={styles.linkLeft}>
                <Ionicons name="bulb-outline" size={17} color={theme.colors.primaryMuted} />
                <Text style={styles.linkText}>思考内容展示</Text>
              </View>
              <View style={styles.thinkingDisplayChips}>
                {THINKING_DISPLAYS.map(display => {
                  const active = thinkingDisplay === display;
                  const label = display === 'open' ? '开启' : display === 'fold' ? '折叠' : '关闭';
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
                <Text style={styles.linkText}>气泡风格</Text>
              </View>
              <View style={styles.thinkingDisplayChips}>
                {BUBBLE_STYLES.map(style => {
                  const active = (chatOptions.bubbleStyle || 'rounded') === style;
                  const label = style === 'rounded' ? '圆润' : style === 'card' ? '卡片' : '无底纹';
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
            <CollapsibleHint>{'圆润：大圆角气泡（默认）；卡片：统一中等圆角、无尾角，偏阅读；无底纹：去掉气泡底色与阴影，仅靠左右对齐区分角色。'}</CollapsibleHint>
    </>
  );
}
