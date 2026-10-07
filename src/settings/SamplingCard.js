// 设置页「生成参数」卡：采样字段（maxTokens/temperature/topP/topK）的开关与取值。
//
// 状态、加载与保存逻辑整体从 SettingsScreen 抽出（该域与其它设置域零共享）。
// 卡片自带 UI，SettingsScreen 只需 `<SamplingCard />` 即可渲染。

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Switch, Text, View } from 'react-native';

import { SAMPLING_FIELDS, getSamplingSettings, saveSamplingSettings } from '../storage/settings.js';
import { Card, CollapsibleSection, TextField } from '../ui/index.js';
import { useTheme } from '../theme/ThemeContext.js';
import { createSettingsStyles } from './settingsStyles.js';
import { useTranslation } from '../i18n/I18nContext.js';

const SAMPLING_ITEMS = [
  { name: 'maxTokens', labelKey: 'settings.sampling.maxTokens', keyboard: 'number-pad', hint: '1 - 128000' },
  { name: 'temperature', labelKey: 'settings.sampling.temperature', keyboard: 'decimal-pad', hint: '0 - 2' },
  { name: 'topP', labelKey: 'settings.sampling.topP', keyboard: 'decimal-pad', hint: '0 - 1' },
  { name: 'topK', labelKey: 'settings.sampling.topK', keyboard: 'number-pad', hint: '0 - 50' },
];

const DEFAULT_SAMPLING = {
  maxTokens: { enabled: false, value: 8024 },
  temperature: { enabled: false, value: 1 },
  topP: { enabled: false, value: 1 },
  topK: { enabled: false, value: 0 },
};

export default function SamplingCard({ open, onToggle, flash } = {}) {
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
  const styles = React.useMemo(() => createSettingsStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const [sampling, setSampling] = useState(DEFAULT_SAMPLING);
  const samplingRef = useRef(DEFAULT_SAMPLING);

  useEffect(() => {
    getSamplingSettings()
      .then(settings => {
        samplingRef.current = settings;
        setSampling(settings);
      })
      .catch(() => {});
  }, []);

  const persistSampling = useCallback(async next => {
    samplingRef.current = next;
    setSampling(next);
    try {
      const saved = await saveSamplingSettings(next);
      samplingRef.current = saved;
      setSampling(saved);
    } catch (error) {
      Alert.alert(t('settings.sampling.alert.saveFailed.title'), t('settings.sampling.alert.saveFailed.body'));
    }
  }, [t]);

  const toggleSamplingField = useCallback(name => {
    const current = samplingRef.current;
    const field = current[name] || {};
    persistSampling({
      ...current,
      [name]: { ...field, enabled: field.enabled !== true },
    });
  }, [persistSampling]);

  const commitSamplingValue = useCallback((name, rawText) => {
    const rule = SAMPLING_FIELDS[name];
    if (!rule) return;
    const current = samplingRef.current;
    const field = current[name] || {};
    const trimmed = String(rawText == null ? '' : rawText).trim();
    let value;
    if (!trimmed || !Number.isFinite(Number(trimmed))) {
      value = rule.default;
    } else {
      value = Number(trimmed);
      if (rule.integer) value = Math.round(value);
      if (value < rule.min || value > rule.max) {
        const clamped = Math.min(rule.max, Math.max(rule.min, value));
        Alert.alert(t('settings.sampling.alert.outOfRange.title'), t('settings.sampling.alert.outOfRange.body', { value: clamped }));
        value = clamped;
      }
    }
    persistSampling({
      ...current,
      [name]: { enabled: field.enabled === true, value },
    });
  }, [persistSampling, t]);

  const enabledCount = Object.values(sampling).filter(f => f && f.enabled === true).length;

  return (
    <Card style={[styles.sectionCard, flash && styles.sectionCardFlash]}>
      <CollapsibleSection
        title={t('settings.sampling.title')}
        icon="analytics-outline"
        open={open}
        onToggle={onToggle}
        right={<Text style={styles.collapseSummary} numberOfLines={1}>
          {enabledCount > 0 ? t('settings.sampling.enabledCount', { count: enabledCount }) : t('settings.sampling.serverDefault')}
        </Text>}
      >
        {SAMPLING_ITEMS.map(item => {
          const field = sampling[item.name] || {};
          return (
            <View key={item.name} style={styles.capabilityRow}>
              <View style={styles.linkLeft}>
                <Text style={styles.linkText} numberOfLines={1}>{t(item.labelKey)}</Text>
              </View>
              <View style={styles.samplingRight}>
                <TextField
                  style={styles.samplingInput}
                  value={String(field.value == null ? '' : field.value)}
                  onChangeText={text => {
                    const current = samplingRef.current;
                    const next = {
                      ...current,
                      [item.name]: { ...(current[item.name] || {}), value: text },
                    };
                    samplingRef.current = next;
                    setSampling(next);
                  }}
                  onEndEditing={event => commitSamplingValue(item.name, event.nativeEvent.text)}
                  keyboardType={item.keyboard}
                  placeholder={item.hint}
                />
                <Switch
                  value={field.enabled === true}
                  onValueChange={() => toggleSamplingField(item.name)}
                  trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
                  thumbColor={theme.colors.primaryContrast}
                />
              </View>
            </View>
          );
        })}
        <Text style={styles.fieldHint}>{t('settings.sampling.hint')}</Text>
      </CollapsibleSection>
    </Card>
  );
}
