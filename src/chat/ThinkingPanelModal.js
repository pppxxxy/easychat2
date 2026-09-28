// 思考设置弹窗。从 src/ChatScreen.js 原样外提（无行为变化）。

import React, { useMemo } from 'react';
import { Modal, Pressable, Switch, Text, TouchableOpacity, View } from 'react-native';

import { useTheme } from '../theme/ThemeContext';
import { THINKING_DISPLAYS, THINKING_LEVELS } from '../storage';
import { THINKING_DISPLAY_LABELS, THINKING_LEVEL_LABELS } from './chatConstants';
import { createChatStyles } from './chatStyles';

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
          <Text style={styles.modelTitle}>思考设置</Text>
          {!thinkingSupported ? (
            <Text style={styles.modelEmpty}>
              当前来源未标记为支持思考，请在设置中确认模型能力。
            </Text>
          ) : null}
          <View style={styles.thinkingRow}>
            <Text style={styles.thinkingLabel}>开启思考</Text>
            <Switch
              value={thinkingEnabled}
              onValueChange={value => applyThinking({ enabled: value })}
              disabled={!thinkingSupported}
              trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
              thumbColor={theme.colors.primaryContrast}
            />
          </View>
          <Text style={styles.modelLabel}>思考深度</Text>
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
          <Text style={styles.modelLabel}>思考内容展示</Text>
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
            <Text style={styles.modelCloseText}>关闭</Text>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
