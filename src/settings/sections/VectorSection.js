import React from 'react';
import { Switch, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import {
  CollapsibleSelect,
  FieldHint,
  FieldLabel,
  SecondaryButton,
  TextField,
} from '../../ui/index.js';
import SecretTextField from '../SecretTextField.js';

export default function VectorSection(props) {
  const {
    styles,
    theme,
    t,
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
    confirmClearVectorIndex,
    activeCharacterName,
  } = props;
  return (
    <>
          <View style={styles.capabilityRow}>
            <View style={styles.linkLeft}>
              <Text style={styles.linkText}>{t('settings.vector.enable')}</Text>
            </View>
            <Switch
              value={vectorPayload.enabled === true}
              onValueChange={toggleVectorEnabled}
              trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
              thumbColor={theme.colors.primaryContrast}
            />
          </View>
          <FieldHint style={styles.hint}>{t('settings.vector.enableHint')}</FieldHint>
          <View style={styles.personaActions}>
            <TouchableOpacity style={styles.personaAddChip} onPress={confirmClearVectorIndex} activeOpacity={0.8}>
              <Ionicons name="trash-outline" size={14} color={theme.colors.danger} />
              <Text style={[styles.personaAddText, { color: theme.colors.danger }]}>
                {t('settings.vector.clear.entry', { name: activeCharacterName || t('settings.vector.clear.currentRole') })}
              </Text>
            </TouchableOpacity>
          </View>
          <FieldLabel style={styles.label}>{t('settings.vector.config')}</FieldLabel>
          <CollapsibleSelect
            label={t('settings.api.current')}
            value={vectorPayload.activeId}
            options={(vectorPayload.configs || []).map(item => ({
              value: item.id,
              label: item.name || t('settings.api.unnamed'),
              meta: `${item.baseUrl || t('settings.api.noAddress')} · ${item.model || t('settings.api.noModel')}`,
            }))}
            onSelect={id => selectVectorConfig(id)}
            placeholder={t('settings.api.noneSelected')}
          />
          <View style={styles.personaActions}>
            <TouchableOpacity style={styles.personaAddChip} onPress={addVectorConfig} activeOpacity={0.8}>
              <Ionicons name="add" size={15} color={theme.colors.primarySoft} />
              <Text style={styles.personaAddText}>{t('settings.vector.add')}</Text>
            </TouchableOpacity>
            {(vectorPayload.configs || []).length > 1 ? (
              <TouchableOpacity style={styles.personaAddChip} onPress={removeVectorConfig} activeOpacity={0.8}>
                <Ionicons name="trash-outline" size={14} color={theme.colors.danger} />
                <Text style={[styles.personaAddText, { color: theme.colors.danger }]}>{t('settings.vector.deleteCurrent')}</Text>
              </TouchableOpacity>
            ) : null}
          </View>
          {currentVectorConfig ? (
            <>
              <FieldLabel style={styles.label}>{t('settings.api.name')}</FieldLabel>
              <TextField
                value={currentVectorConfig.name}
                onChangeText={text => updateVectorConfig({ name: text })}
                onEndEditing={() => flushVectorMemory()}
                placeholder={t('settings.vector.namePlaceholder')}
              />
              <FieldLabel style={styles.label}>{t('settings.vector.baseUrl')}</FieldLabel>
              <TextField
                value={currentVectorConfig.baseUrl}
                onChangeText={text => updateVectorConfig({ baseUrl: text })}
                onEndEditing={() => flushVectorMemory()}
                placeholder="https://api.openai.com/v1"
                autoCapitalize="none"
                autoCorrect={false}
              />
              <FieldLabel style={styles.label}>{t('settings.vector.apiKey')}</FieldLabel>
              <SecretTextField
                value={currentVectorConfig.apiKey}
                onChangeText={text => updateVectorConfig({ apiKey: text })}
                onEndEditing={() => flushVectorMemory()}
                placeholder="sk-..."
                theme={theme}
                styles={styles}
              />
              <FieldLabel style={styles.label}>{t('settings.vector.model')}</FieldLabel>
              <TextField
                value={currentVectorConfig.model}
                onChangeText={text => updateVectorConfig({ model: text })}
                onEndEditing={() => flushVectorMemory()}
                placeholder="text-embedding-3-small"
                autoCapitalize="none"
                autoCorrect={false}
              />
              <FieldLabel style={styles.label}>{t('settings.vector.topK')}</FieldLabel>
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
              <FieldLabel style={styles.label}>{t('settings.vector.chunkSize')}</FieldLabel>
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
                title={vectorTesting ? t('settings.vector.testing') : t('settings.vector.test')}
                icon="pulse-outline"
                onPress={testVector}
                loading={vectorTesting}
                style={styles.actionBtn}
              />
            </>
          ) : null}
          <Text style={styles.fieldHint}>
            {t('settings.vector.hint')}
          </Text>
    </>
  );
}
