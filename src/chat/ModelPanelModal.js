// 切换模型弹窗。从 src/ChatScreen.js 原样外提（无行为变化）。
// 2026-10-01 追加「本地模型」分组：可加载/卸载本地模型并打开运行日志。

import React, { useMemo } from 'react';
import { Modal, Pressable, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme } from '../theme/ThemeContext.js';
import { useTranslation } from '../i18n/I18nContext.js';
import { formatBytes } from '../utils/format.js';
import { createChatStyles } from './chatStyles.js';

export default function ModelPanelModal({
  visible,
  onClose,
  apiConfigs,
  modelSourceId,
  setModelSourceId,
  applyModelSelection,
  isSending,
  localModels = [],
  activeLocalModelId = '',
  loadingLocalModelId = '',
  onActivateLocalModel,
  onDeactivateLocalModel,
  onOpenModelLogs,
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
          <Text style={styles.modelTitle}>{t('chat.modelPanel.title')}</Text>
          <Text style={styles.modelLabel}>{t('chat.modelPanel.source')}</Text>
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
                      {config.name || t('chat.modelPanel.unnamedConfig')}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </ScrollView>
          <Text style={styles.modelLabel}>{t('chat.modelPanel.model')}</Text>
          <ScrollView style={styles.modelListScroll}>
            {(() => {
              const source = apiConfigs.find(item => item.id === modelSourceId);
              const models = (source && source.models) || [];
              if (models.length === 0) {
                return <Text style={styles.modelEmpty}>{t('chat.modelPanel.emptyModels')}</Text>;
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

          <View style={styles.localHeaderRow}>
            <Text style={styles.modelLabel}>{t('chat.modelPanel.localTitle')}</Text>
            <TouchableOpacity
              onPress={onOpenModelLogs}
              activeOpacity={0.8}
              accessibilityRole="button"
              accessibilityLabel={t('chat.modelPanel.logsA11y')}
            >
              <Text style={styles.localLogLink}>{t('chat.modelPanel.logsLink')}</Text>
            </TouchableOpacity>
          </View>
          <ScrollView style={styles.modelListScroll}>
            {localModels.length === 0 ? (
              <Text style={styles.modelEmpty}>{t('chat.modelPanel.localEmpty')}</Text>
            ) : (
              localModels.map(entry => {
                const active = entry.id === activeLocalModelId;
                const loading = entry.id === loadingLocalModelId;
                const meta = [entry.quant, formatBytes(entry.modelBytes)].filter(Boolean).join(' · ');
                return (
                  <View key={entry.id} style={styles.localRow}>
                    <View style={styles.localInfo}>
                      <Text style={styles.localName} numberOfLines={1}>
                        {entry.name || entry.id}{active ? ` · ${t('chat.modelPanel.current')}` : ''}
                      </Text>
                      {meta ? <Text style={styles.localMeta} numberOfLines={1}>{meta}</Text> : null}
                    </View>
                    <TouchableOpacity
                      style={[styles.localAction, active && styles.localActionActive, (isSending || loading) && styles.actionDisabled]}
                      disabled={isSending || loading}
                      onPress={() => (active ? onDeactivateLocalModel() : onActivateLocalModel(entry))}
                      activeOpacity={0.8}
                      accessibilityRole="button"
                      accessibilityLabel={t(active ? 'chat.modelPanel.unloadA11y' : 'chat.modelPanel.loadA11y', { name: entry.name || entry.id })}
                    >
                      <Text style={styles.localActionText}>{loading ? t('chat.modelPanel.loading') : active ? t('chat.modelPanel.unload') : t('chat.modelPanel.load')}</Text>
                    </TouchableOpacity>
                  </View>
                );
              })
            )}
          </ScrollView>

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
