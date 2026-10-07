// 思考设置弹窗。从 src/ChatScreen.js 原样外提（无行为变化）。

import React, { useMemo } from 'react';
import { Modal, Pressable, Switch, Text, TouchableOpacity, View } from 'react-native';

import { useTheme } from '../theme/ThemeContext.js';
import { useTranslation } from '../i18n/I18nContext.js';
import { THINKING_DISPLAYS, THINKING_LEVELS } from '../storage/settings.js';
import { THINKING_DISPLAY_LABELS, THINKING_LEVEL_LABELS } from './chatConstants.js';
import { createChatStyles } from './chatStyles.js';

export default function ThinkingPanelModal({
  visible,
  onClose,
  thinkingSupported,
  thinkingEnabled,
  thinkingLevel,
  thinkingDisplay,
  applyThinking,
}) {
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
  const styles = useMemo(() => createChatStyles(theme, fonts, tokens), [theme, fonts, tokens]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable
        style={styles.modelBackdrop}
        onPress={onClose}
      >
        <Pressable style={styles.modelSheet} onPress={() => {}}>
          <Text style={styles.modelTitle}>{t('chat.thinkingPanel.title')}</Text>
          {!thinkingSupported ? (
            <Text style={styles.modelEmpty}>
              {t('chat.thinkingPanel.unsupported')}
            </Text>
          ) : null}
          <View style={styles.thinkingRow}>
            <Text style={styles.thinkingLabel}>{t('chat.thinkingPanel.enable')}</Text>
            <Switch
              value={thinkingEnabled}
              onValueChange={value => applyThinking({ enabled: value })}
              disabled={!thinkingSupported}
              trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
              thumbColor={theme.colors.primaryContrast}
            />
          </View>
          <Text style={styles.modelLabel}>{t('chat.thinkingPanel.depth')}</Text>
          <View style={styles.thinkingLevels}>
            {THINKING_LEVELS.map(level => {
              const active = thinkingLevel === level;
              const disabled = !thinkingSupported || !thinkingEnabled;
              return (
                <TouchableOpacity
                  key={level}
                  style={[
                    styles.thinkingLevelChip,
                    active && styles.thinkingLevelChipActive,
                    disabled && styles.actionDisabled,
                  ]}
                  disabled={disabled}
                  onPress={() => applyThinking({ level })}
                  activeOpacity={0.8}
                >
                  <Text
                    style={[
                      styles.thinkingLevelText,
                      active && styles.thinkingLevelTextActive,
                    ]}
                  >
                    {THINKING_LEVEL_LABELS[level]}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
          <Text style={styles.modelLabel}>{t('chat.thinkingPanel.display')}</Text>
          <View style={styles.thinkingLevels}>
            {THINKING_DISPLAYS.map(display => {
              const active = thinkingDisplay === display;
              const disabled = !thinkingSupported || !thinkingEnabled;
              return (
                <TouchableOpacity
                  key={display}
                  style={[
                    styles.thinkingLevelChip,
                    active && styles.thinkingLevelChipActive,
                    disabled && styles.actionDisabled,
                  ]}
                  disabled={disabled}
                  onPress={() => applyThinking({ display })}
                  activeOpacity={0.8}
                >
                  <Text
                    style={[
                      styles.thinkingLevelText,
                      active && styles.thinkingLevelTextActive,
                    ]}
                  >
                    {THINKING_DISPLAY_LABELS[display]}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
          <TouchableOpacity
            style={styles.modelClose}
            onPress={onClose}
            activeOpacity={0.8}
          >
            <Text style={styles.modelCloseText}>{t('common.close')}</Text>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
