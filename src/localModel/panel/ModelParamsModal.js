// 推理参数弹窗（纯渲染）：7 个字段由 LOCAL_MODEL_PARAM_FIELDS 驱动，范围提示
// 用字段定义里的 min/max（U7 的轻量版：加 hint，不做越界红框/恢复默认——可选项延后）。
// 打开/校验/保存逻辑在壳（openParams/saveParams），本组件不弹 Alert。

import React from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Modal, Platform, ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { LOCAL_MODEL_PARAM_FIELDS } from '../modelParams.js';
import { PARAM_LABELS } from './panelShared.js';

export default function ModelParamsModal({
  visible,
  target,
  form,
  busy,
  styles,
  theme,
  onFieldChange,
  onClose,
  onSave,
}) {
  const rangeHint = field => {
    const def = LOCAL_MODEL_PARAM_FIELDS[field];
    if (!def) return '';
    if (!Number.isFinite(def.min) || !Number.isFinite(def.max)) return '';
    return `范围 ${def.min} – ${def.max}`;
  };
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.backdrop} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>推理参数</Text>
            <TouchableOpacity onPress={onClose} hitSlop={8} accessibilityLabel="关闭">
              <Ionicons name="close" size={22} color={theme.colors.textMuted} />
            </TouchableOpacity>
          </View>
          <Text style={styles.hint}>{target ? `${target.name || target.id}：参数只作用于该模型。` : ''}</Text>
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            {Object.keys(LOCAL_MODEL_PARAM_FIELDS).map(field => (
              <View key={field} style={styles.paramField}>
                <Text style={styles.label}>
                  {PARAM_LABELS[field] || field}
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
              <Text style={styles.primaryText}>{busy ? '保存中...' : '保存参数'}</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
