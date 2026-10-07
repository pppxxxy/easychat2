// 切换模型弹窗。从 src/ChatScreen.js 原样外提（无行为变化）。
// v5 Stage C：瘦身为「纯切换器」——本地模型只做选用/取消选用（切换开关），
// 加载/卸载/删除/参数等写操作统一收进「模型中心」（底部「管理本地模型…」入口）。

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
  onSelectLocalModel,
  onManageLocalModels,
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
          </View>
          <ScrollView style={styles.modelListScroll}>
            {localModels.length === 0 ? (
              <Text style={styles.modelEmpty}>{t('chat.modelPanel.localEmpty')}</Text>
            ) : (
              localModels.map(entry => {
                const active = entry.id === activeLocalModelId;
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
                      style={[styles.localAction, active && styles.localActionActive, isSending && styles.actionDisabled]}
                      disabled={isSending}
                      onPress={() => onSelectLocalModel(entry, !active)}
                      activeOpacity={0.8}
                      accessibilityRole="button"
                      accessibilityLabel={t(active ? 'chat.modelPanel.deselectA11y' : 'chat.modelPanel.selectA11y', { name: entry.name || entry.id })}
                    >
                      <Text style={styles.localActionText}>{active ? t('chat.modelPanel.deselect') : t('chat.modelPanel.select')}</Text>
                    </TouchableOpacity>
                  </View>
                );
              })
            )}
          </ScrollView>

          {/* 管理入口：加载/卸载/删除/参数等写操作统一在模型中心（v5 Stage C）。 */}
          <TouchableOpacity
            style={styles.modelClose}
            onPress={onManageLocalModels}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel={t('chat.modelPanel.manageA11y')}
          >
            <Ionicons name="settings-outline" size={16} color={theme.colors.primarySoft} />
            <Text style={styles.localLogLink}>{t('chat.modelPanel.manage')}</Text>
          </TouchableOpacity>

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
