// 推理参数弹窗（纯渲染）：7 个字段由 LOCAL_MODEL_PARAM_FIELDS 驱动。
// U7 完整版：范围提示 + 越界红框（即时校验）+ 每字段「恢复默认」按钮。
// 打开/校验/保存逻辑在 useModelParams + panelFeedback.createParamsSaver，本组件不弹 Alert。

import React from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Modal, Platform, ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { checkLocalModelParamField, LOCAL_MODEL_PARAM_FIELDS } from '../modelParams.js';
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

  const fieldError = field => {
    const check = checkLocalModelParamField(field, form[field]);
    if (check.ok) return '';
    if (check.code === 'NOT_NUMBER') return t('localModel.paramsModal.errNumber');
    const def = LOCAL_MODEL_PARAM_FIELDS[field] || {};
    return t('localModel.paramsModal.errRange', { min: def.min, max: def.max });
  };

  // 全部恢复默认：逐字段回填各自 default（与单字段按钮走同一条 onFieldChange）。
  const resetAll = () => {
    Object.keys(LOCAL_MODEL_PARAM_FIELDS).forEach(field => {
      onFieldChange(field, String(LOCAL_MODEL_PARAM_FIELDS[field].default));
    });
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
            {Object.keys(LOCAL_MODEL_PARAM_FIELDS).map(field => {
              const errorText = fieldError(field);
              return (
                <View key={field} style={styles.paramField}>
                  <View style={styles.paramLabelRow}>
                    <Text style={styles.label}>
                      {t(PARAM_LABEL_KEYS[field] || '') || field}
                      {rangeHint(field) ? `（${rangeHint(field)}）` : ''}
                    </Text>
                    <TouchableOpacity
                      onPress={() => onFieldChange(field, String(LOCAL_MODEL_PARAM_FIELDS[field].default))}
                      hitSlop={8}
                      accessibilityLabel={`${t('localModel.paramsModal.reset')}（${t(PARAM_LABEL_KEYS[field] || '') || field}）`}
                    >
                      <Text style={styles.resetText}>{t('localModel.paramsModal.reset')}</Text>
                    </TouchableOpacity>
                  </View>
                  <TextInput
                    style={[styles.input, errorText ? styles.inputError : null]}
                    value={form[field] ?? ''}
                    onChangeText={text => onFieldChange(field, text)}
                    placeholderTextColor={theme.colors.textFaint}
                    accessibilityLabel={t(PARAM_LABEL_KEYS[field] || '') || field}
                  />
                  {errorText ? <Text style={styles.fieldError}>{errorText}</Text> : null}
                </View>
              );
            })}
            <TouchableOpacity style={styles.resetAll} onPress={resetAll} disabled={busy} activeOpacity={0.8}>
              <Ionicons name="refresh-outline" size={14} color={theme.colors.primary} />
              <Text style={styles.resetAllText}>{t('localModel.paramsModal.resetAll')}</Text>
            </TouchableOpacity>
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
