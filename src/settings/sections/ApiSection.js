import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import {
  CollapsibleSelect,
  DangerButton,
  FieldHint,
  FieldLabel,
  PrimaryButton,
  TextField,
} from '../../ui/index.js';
import SecretTextField from '../SecretTextField.js';

export default function ApiSection(props) {
  const {
    styles,
    theme,
    activeId,
    active,
    activeVendor,
    configs,
    CHAT_PROTOCOL_OPTIONS,
    modelDraft,
    setModelDraft,
    detectingModels,
    selectConfig,
    updateField,
    changeProtocol,
    addModel,
    searchModels,
    selectActiveModel,
    openCapabilityEditor,
    removeModel,
    detectModels,
    openApiKeyUrl,
    save,
    deleteConfig,
  } = props;
  return (
    <>
          <CollapsibleSelect
            label="当前配置"
            value={activeId}
            options={configs.map(item => ({
              value: item.id,
              label: item.name || '未命名配置',
              meta: `${item.baseUrl || '未填写地址'} · ${item.activeModel || '未填写模型'}`,
            }))}
            onSelect={id => selectConfig(id)}
            placeholder="未选择配置"
            emptyHint="暂无配置，点右上角「新建」"
            style={styles.configSelect}
          />

          {active ? (
            <>
              <FieldLabel style={styles.label}>配置名称</FieldLabel>
              <TextField
                value={active.name}
                onChangeText={name => updateField({ name })}
                placeholder="例如：DeepSeek 主力"
              />
              <FieldLabel style={styles.label}>API 地址</FieldLabel>
              <TextField
                value={active.baseUrl}
                onChangeText={baseUrl => updateField({ baseUrl })}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="https://api.deepseek.com"
              />
              <FieldHint style={styles.hint}>可填根地址，或带 /v1、/v1/chat/completions 的完整地址。</FieldHint>
              <FieldLabel style={styles.label}>接口协议</FieldLabel>
              <View style={styles.thinkingFormatRow}>
                {CHAT_PROTOCOL_OPTIONS.map(option => {
                  const isActive = (active.protocol || 'openai') === option.id;
                  return (
                    <TouchableOpacity
                      key={option.id}
                      style={[styles.formatChip, isActive && styles.formatChipActive]}
                      onPress={() => changeProtocol(option.id)}
                      activeOpacity={0.8}
                    >
                      <Text style={[styles.formatChipText, isActive && styles.formatChipTextActive]}>
                        {option.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              <FieldHint style={styles.hint}>
                {(active.protocol || 'openai') === 'anthropic'
                  ? 'Anthropic Messages 协议：端点 /v1/messages，鉴权 x-api-key；不支持内联音频。'
                  : (active.protocol === 'openai-responses'
                    ? 'OpenAI Responses 协议：端点 /v1/responses，事件式流式。'
                    : 'OpenAI 兼容协议：端点 /v1/chat/completions，最通用。')}
              </FieldHint>
              <FieldLabel style={styles.label}>模型列表</FieldLabel>
              <View style={styles.modelRow}>
                <TextField
                  style={styles.modelInput}
                  value={modelDraft}
                  onChangeText={setModelDraft}
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholder="输入模型名后点击添加"
                  onSubmitEditing={addModel}
                />
                <TouchableOpacity
                  style={styles.detectButton}
                  onPress={addModel}
                  activeOpacity={0.8}
                >
                  <Ionicons name="add" size={15} color={theme.colors.primarySoft} />
                  <Text style={styles.detectButtonText}>添加</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.detectButton, styles.modelSearchButton, detectingModels && styles.buttonDisabled]}
                  onPress={searchModels}
                  disabled={detectingModels}
                  activeOpacity={0.8}
                  accessibilityRole="button"
                  accessibilityLabel="按输入内容搜索接口上的模型"
                >
                  <Ionicons name="search" size={15} color={theme.colors.primarySoft} />
                  <Text style={styles.detectButtonText}>搜索</Text>
                </TouchableOpacity>
              </View>
              <View style={styles.modelChips}>
                {(active.models || []).map(model => {
                  const isActive = active.activeModel === model;
                  return (
                    <View
                      key={model}
                      style={[styles.modelChip, isActive && styles.modelChipActive]}
                    >
                      <TouchableOpacity
                        style={styles.modelChipMain}
                        onPress={() => selectActiveModel(model)}
                        activeOpacity={0.7}
                      >
                        <Text
                          style={[styles.modelChipText, isActive && styles.modelChipTextActive]}
                          numberOfLines={1}
                        >
                          {model}
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        onPress={() => openCapabilityEditor(model)}
                        hitSlop={6}
                        accessibilityLabel={`配置模型 ${model} 的能力`}
                        style={styles.modelChipCaps}
                      >
                        <Ionicons
                          name="options-outline"
                          size={13}
                          color={(active.modelCapabilities && active.modelCapabilities[model])
                            ? theme.colors.primarySoft
                            : theme.colors.textFaint}
                        />
                      </TouchableOpacity>
                      <TouchableOpacity onPress={() => removeModel(model)} hitSlop={6}>
                        <Ionicons name="close" size={14} color={theme.colors.textFaint} />
                      </TouchableOpacity>
                    </View>
                  );
                })}
              </View>
              <FieldHint style={styles.hint}>点击模型将其设为当前模型；点右侧滑杆图标可为每个模型单独确认能力（思考/识图/视频/语音识别）。</FieldHint>
              <TouchableOpacity
                style={[styles.detectButton, detectingModels && styles.buttonDisabled]}
                onPress={detectModels}
                disabled={detectingModels}
                activeOpacity={0.8}
              >
                <Ionicons name="pulse-outline" size={15} color={theme.colors.primarySoft} />
                <Text style={styles.detectButtonText}>
                  {detectingModels ? '检测中...' : '检测模型'}
                </Text>
              </TouchableOpacity>
              <FieldLabel style={styles.label}>API Key</FieldLabel>
              <SecretTextField
                value={active.apiKey}
                onChangeText={apiKey => updateField({ apiKey })}
                placeholder="sk-..."
                theme={theme}
                styles={styles}
              />
              {active.apiKeyUrl ? (
                <TouchableOpacity
                  style={styles.apiKeyLinkRow}
                  onPress={() => openApiKeyUrl(active.apiKeyUrl)}
                  activeOpacity={0.7}
                  accessibilityRole="link"
                  accessibilityLabel="点击获取密钥"
                >
                  <Text style={styles.apiKeyLink}>点击获取密钥 →</Text>
                </TouchableOpacity>
              ) : null}
              {activeVendor && activeVendor.note ? (
                <Text style={styles.vendorEditorNote}>{activeVendor.note}</Text>
              ) : null}
              <FieldHint style={styles.hint}>
                API Key 与聊天内容会直接发送到你填写的地址，并保存在本机。请确认你信任该服务商。
              </FieldHint>
              <PrimaryButton
                title="保存配置"
                icon="save-outline"
                onPress={save}
                style={styles.actionBtn}
              />
              <DangerButton
                title="删除当前配置"
                icon="trash-outline"
                onPress={deleteConfig}
                disabled={configs.length <= 1}
                style={styles.actionBtn}
              />
            </>
          ) : null}
    </>
  );
}
