import React from 'react';
import { Switch, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import {
  CollapsibleSelect,
  FieldLabel,
  SecondaryButton,
  TextField,
} from '../../ui/index.js';
import SecretTextField from '../SecretTextField.js';

export default function VectorSection(props) {
  const {
    styles,
    theme,
    vectorPayload,
    toggleVectorEnabled,
    selectVectorConfig,
    addVectorConfig,
    removeVectorConfig,
    currentVectorConfig,
    updateVectorConfig,
    flushVectorMemory,
    vectorRef,
    vectorTopKDraft,
    setVectorTopKDraft,
    vectorMaxCharsDraft,
    setVectorMaxCharsDraft,
    vectorTesting,
    testVector,
  } = props;
  return (
    <>
          <View style={styles.capabilityRow}>
            <View style={styles.linkLeft}>
              <Text style={styles.linkText}>启用向量检索</Text>
            </View>
            <Switch
              value={vectorPayload.enabled === true}
              onValueChange={toggleVectorEnabled}
              trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
              thumbColor={theme.colors.primaryContrast}
            />
          </View>
          <FieldLabel style={styles.label}>向量配置</FieldLabel>
          <CollapsibleSelect
            label="当前配置"
            value={vectorPayload.activeId}
            options={(vectorPayload.configs || []).map(item => ({
              value: item.id,
              label: item.name || '未命名配置',
              meta: `${item.baseUrl || '未填写地址'} · ${item.model || '未填写模型'}`,
            }))}
            onSelect={id => selectVectorConfig(id)}
            placeholder="未选择配置"
          />
          <View style={styles.personaActions}>
            <TouchableOpacity style={styles.personaAddChip} onPress={addVectorConfig} activeOpacity={0.8}>
              <Ionicons name="add" size={15} color={theme.colors.primarySoft} />
              <Text style={styles.personaAddText}>新增配置</Text>
            </TouchableOpacity>
            {(vectorPayload.configs || []).length > 1 ? (
              <TouchableOpacity style={styles.personaAddChip} onPress={removeVectorConfig} activeOpacity={0.8}>
                <Ionicons name="trash-outline" size={14} color={theme.colors.danger} />
                <Text style={[styles.personaAddText, { color: theme.colors.danger }]}>删除当前</Text>
              </TouchableOpacity>
            ) : null}
          </View>
          {currentVectorConfig ? (
            <>
              <FieldLabel style={styles.label}>配置名称</FieldLabel>
              <TextField
                value={currentVectorConfig.name}
                onChangeText={text => updateVectorConfig({ name: text })}
                onEndEditing={() => flushVectorMemory()}
                placeholder="例如：OpenAI Embeddings"
              />
              <FieldLabel style={styles.label}>接口地址</FieldLabel>
              <TextField
                value={currentVectorConfig.baseUrl}
                onChangeText={text => updateVectorConfig({ baseUrl: text })}
                onEndEditing={() => flushVectorMemory()}
                placeholder="https://api.openai.com/v1"
                autoCapitalize="none"
                autoCorrect={false}
              />
              <FieldLabel style={styles.label}>密钥</FieldLabel>
              <SecretTextField
                value={currentVectorConfig.apiKey}
                onChangeText={text => updateVectorConfig({ apiKey: text })}
                onEndEditing={() => flushVectorMemory()}
                placeholder="sk-..."
                theme={theme}
                styles={styles}
              />
              <FieldLabel style={styles.label}>模型</FieldLabel>
              <TextField
                value={currentVectorConfig.model}
                onChangeText={text => updateVectorConfig({ model: text })}
                onEndEditing={() => flushVectorMemory()}
                placeholder="text-embedding-3-small"
                autoCapitalize="none"
                autoCorrect={false}
              />
              <FieldLabel style={styles.label}>召回条数（1 - 20）</FieldLabel>
              <TextField
                value={vectorTopKDraft}
                onChangeText={text => setVectorTopKDraft(text.replace(/[^0-9]/g, ''))}
                onEndEditing={event => {
                  updateVectorConfig({ topK: event.nativeEvent.text });
                  flushVectorMemory().then(() => {
                    const base = vectorRef.current;
                    const active = base && base.configs.find(item => item.id === base.activeId);
                    if (active) setVectorTopKDraft(String(active.topK));
                  });
                }}
                keyboardType="number-pad"
                placeholder="5"
              />
              <FieldLabel style={styles.label}>分片长度（字符，1 - 2000）</FieldLabel>
              <TextField
                value={vectorMaxCharsDraft}
                onChangeText={text => setVectorMaxCharsDraft(text.replace(/[^0-9]/g, ''))}
                onEndEditing={event => {
                  updateVectorConfig({ maxChars: event.nativeEvent.text });
                  flushVectorMemory().then(() => {
                    const base = vectorRef.current;
                    const active = base && base.configs.find(item => item.id === base.activeId);
                    if (active) setVectorMaxCharsDraft(String(active.maxChars));
                  });
                }}
                keyboardType="number-pad"
                placeholder="400"
              />
              <SecondaryButton
                title={vectorTesting ? '测试中...' : '测试连接'}
                icon="pulse-outline"
                onPress={testVector}
                loading={vectorTesting}
                style={styles.actionBtn}
              />
            </>
          ) : null}
          <Text style={styles.fieldHint}>
            未配置或请求失败时自动降级为本地关键词检索；密钥仅保存在本机。
          </Text>
    </>
  );
}
