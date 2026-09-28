// 切换模型弹窗。从 src/ChatScreen.js 原样外提（无行为变化）。

import React, { useMemo } from 'react';
import { Modal, Pressable, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme } from '../theme/ThemeContext';
import { createChatStyles } from './chatStyles';

export default function ModelPanelModal({
  visible,
  onClose,
  apiConfigs,
  modelSourceId,
  setModelSourceId,
  applyModelSelection,
  isSending,
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
          <Text style={styles.modelTitle}>切换模型</Text>
          <Text style={styles.modelLabel}>来源</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={styles.modelSourceRow}>
              {apiConfigs.map(config => {
                const selected = config.id === modelSourceId;
                return (
                  <TouchableOpacity
                    key={config.id}
                     style={[styles.modelSourceChip, selected && styles.modelSourceChipActive, isSending && styles.actionDisabled]}
                     onPress={() => setModelSourceId(config.id)}
                     disabled={isSending}
                     activeOpacity={0.8}
                  >
                    <Text
                      style={[styles.modelSourceText, selected && styles.modelSourceTextActive]}
                      numberOfLines={1}
                    >
                      {config.name || '未命名配置'}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </ScrollView>
          <Text style={styles.modelLabel}>模型</Text>
          <ScrollView style={styles.modelListScroll}>
            {(() => {
              const source = apiConfigs.find(item => item.id === modelSourceId);
              const models = (source && source.models) || [];
              if (models.length === 0) {
                return <Text style={styles.modelEmpty}>该来源没有模型。</Text>;
              }
              return models.map(model => {
                const isActive = source.activeModel === model;
                return (
                  <TouchableOpacity
                    key={model}
                     style={[styles.modelOption, isSending && styles.actionDisabled]}
                     onPress={() => applyModelSelection(source.id, model)}
                     disabled={isSending}
                     activeOpacity={0.8}
                  >
                    <Text style={styles.modelOptionText} numberOfLines={1}>{model}</Text>
                    {isActive ? (
                      <Ionicons name="checkmark" size={16} color={theme.colors.primaryMuted} />
                    ) : null}
                  </TouchableOpacity>
                );
              });
            })()}
          </ScrollView>
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
