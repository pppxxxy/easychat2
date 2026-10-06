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
    t,
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
            label={t('settings.api.current')}
            value={activeId}
            options={configs.map(item => ({
              value: item.id,
              label: item.name || t('settings.api.unnamed'),
              meta: `${item.baseUrl || t('settings.api.noAddress')} · ${item.activeModel || t('settings.api.noModel')}`,
            }))}
            onSelect={id => selectConfig(id)}
            placeholder={t('settings.api.noneSelected')}
            emptyHint={t('settings.api.emptyHint')}
            style={styles.configSelect}
          />

          {active ? (
            <>
              <FieldLabel style={styles.label}>{t('settings.api.name')}</FieldLabel>
              <TextField
                value={active.name}
                onChangeText={name => updateField({ name })}
                placeholder={t('settings.api.namePlaceholder')}
              />
              <FieldLabel style={styles.label}>{t('settings.api.baseUrl')}</FieldLabel>
              <TextField
                value={active.baseUrl}
                onChangeText={baseUrl => updateField({ baseUrl })}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="https://api.deepseek.com"
              />
              <FieldHint style={styles.hint}>{t('settings.api.baseUrlHint')}</FieldHint>
              <FieldLabel style={styles.label}>{t('settings.api.protocol')}</FieldLabel>
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
                  ? t('settings.api.protocolAnthropic')
                  : (active.protocol === 'openai-responses'
                    ? t('settings.api.protocolResponses')
                    : t('settings.api.protocolOpenai'))}
              </FieldHint>
              <FieldLabel style={styles.label}>{t('settings.api.modelList')}</FieldLabel>
              <View style={styles.modelRow}>
                <TextField
                  style={styles.modelInput}
                  value={modelDraft}
                  onChangeText={setModelDraft}
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholder={t('settings.api.modelPlaceholder')}
                  onSubmitEditing={addModel}
                />
                <TouchableOpacity
                  style={styles.detectButton}
                  onPress={addModel}
                  activeOpacity={0.8}
                >
                  <Ionicons name="add" size={15} color={theme.colors.primarySoft} />
                  <Text style={styles.detectButtonText}>{t('settings.api.addModel')}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.detectButton, styles.modelSearchButton, detectingModels && styles.buttonDisabled]}
                  onPress={searchModels}
                  disabled={detectingModels}
                  activeOpacity={0.8}
                  accessibilityRole="button"
                  accessibilityLabel={t('settings.api.a11ySearchModels')}
                >
                  <Ionicons name="search" size={15} color={theme.colors.primarySoft} />
                  <Text style={styles.detectButtonText}>{t('settings.api.search')}</Text>
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
                        accessibilityLabel={t('settings.api.a11yConfigureCapability', { model })}
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
              <FieldHint style={styles.hint}>{t('settings.api.modelListHint')}</FieldHint>
              <TouchableOpacity
                style={[styles.detectButton, detectingModels && styles.buttonDisabled]}
                onPress={detectModels}
                disabled={detectingModels}
                activeOpacity={0.8}
              >
                <Ionicons name="pulse-outline" size={15} color={theme.colors.primarySoft} />
                <Text style={styles.detectButtonText}>
                  {detectingModels ? t('common.detecting') : t('settings.api.detectModels')}
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
                  accessibilityLabel={t('settings.api.getKeyA11y')}
                >
                  <Text style={styles.apiKeyLink}>{t('settings.api.getKey')}</Text>
                </TouchableOpacity>
              ) : null}
              {activeVendor && activeVendor.note ? (
                <Text style={styles.vendorEditorNote}>{activeVendor.note}</Text>
              ) : null}
              <FieldHint style={styles.hint}>
                API Key 与聊天内容会直接发送到你填写的地址，并保存在本机。请确认你信任该服务商。
              </FieldHint>
              <PrimaryButton
                title={t('settings.api.save')}
                icon="save-outline"
                onPress={save}
                style={styles.actionBtn}
              />
              <DangerButton
                title={t('settings.api.deleteCurrent')}
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
