// 推理参数弹窗（纯渲染）：7 个字段由 LOCAL_MODEL_PARAM_FIELDS 驱动，范围提示
// 用字段定义里的 min/max（U7 的轻量版：加 hint，不做越界红框/恢复默认——可选项延后）。
// 打开/校验/保存逻辑在壳（openParams/saveParams），本组件不弹 Alert。

import React from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Modal, Platform, ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { LOCAL_MODEL_PARAM_FIELDS } from '../modelParams.js';
import { PARAM_LABEL_KEYS } from './panelShared.js';

export default function ModelParamsModal({
  visible,
  target,
  form,
  busy,
  styles,
  theme,
  t,
  onFieldChange,
  onClose,
  onSave,
}) {
  const rangeHint = field => {
    const def = LOCAL_MODEL_PARAM_FIELDS[field];
    if (!def) return '';
    if (!Number.isFinite(def.min) || !Number.isFinite(def.max)) return '';
    return t('localModel.paramsModal.range', { min: def.min, max: def.max });
  };
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.backdrop} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>{t('localModel.paramsModal.title')}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={8} accessibilityLabel={t('common.close')}>
              <Ionicons name="close" size={22} color={theme.colors.textMuted} />
            </TouchableOpacity>
          </View>
          <Text style={styles.hint}>{target ? t('localModel.paramsModal.hint', { name: target.name || target.id }) : ''}</Text>
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            {Object.keys(LOCAL_MODEL_PARAM_FIELDS).map(field => (
              <View key={field} style={styles.paramField}>
                <Text style={styles.label}>
                  {t(PARAM_LABEL_KEYS[field] || '') || field}
                  {rangeHint(field) ? `（${rangeHint(field)}）` : ''}
                </Text>
                <TextInput
                  style={styles.input}
                  value={form[field] ?? ''}
                  onChangeText={text => onFieldChange(field, text)}
                  placeholderTextColor={theme.colors.textFaint}
                />
              </View>
            ))}
            {busy ? <ActivityIndicator color={theme.colors.primary} style={styles.loading} /> : null}
            <TouchableOpacity style={styles.primary} onPress={onSave} disabled={busy} activeOpacity={0.8}>
              <Text style={styles.primaryText}>{busy ? t('common.saving') : t('localModel.paramsModal.save')}</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
