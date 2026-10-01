// 设置页「生成参数」卡：采样字段（maxTokens/temperature/topP/topK）的开关与取值。
//
// 状态、加载与保存逻辑整体从 SettingsScreen 抽出（该域与其它设置域零共享）。
// 卡片自带 UI，SettingsScreen 只需 `<SamplingCard />` 即可渲染。

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Switch, Text, View } from 'react-native';

import { SAMPLING_FIELDS, getSamplingSettings, saveSamplingSettings } from '../storage.js';
import { Card, CollapsibleSection, TextField } from '../ui/index.js';
import { useTheme } from '../theme/ThemeContext.js';
import { createSettingsStyles } from './settingsStyles.js';

const SAMPLING_ITEMS = [
  { name: 'maxTokens', label: '最大回复令牌', keyboard: 'number-pad', hint: '1 - 128000' },
  { name: 'temperature', label: '温度', keyboard: 'decimal-pad', hint: '0 - 2' },
  { name: 'topP', label: 'top-p', keyboard: 'decimal-pad', hint: '0 - 1' },
  { name: 'topK', label: 'top-k', keyboard: 'number-pad', hint: '0 - 50' },
];

const DEFAULT_SAMPLING = {
  maxTokens: { enabled: false, value: 8024 },
  temperature: { enabled: false, value: 1 },
  topP: { enabled: false, value: 1 },
  topK: { enabled: false, value: 0 },
};

export default function SamplingCard() {
  const { theme, fonts, tokens } = useTheme();
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
      Alert.alert('保存失败', '请检查存储空间或权限。');
    }
  }, []);

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
        Alert.alert('数值超出范围', `已调整为 ${clamped}。`);
        value = clamped;
      }
    }
    persistSampling({
      ...current,
      [name]: { enabled: field.enabled === true, value },
    });
  }, [persistSampling]);

  const enabledCount = Object.values(sampling).filter(f => f && f.enabled === true).length;

  return (
    <Card>
      <CollapsibleSection
        title="生成参数"
        icon="analytics-outline"
        right={<Text style={styles.collapseSummary}>
          {enabledCount > 0 ? `${enabledCount} 项已启用` : '使用服务端默认'}
        </Text>}
      >
        {SAMPLING_ITEMS.map(item => {
          const field = sampling[item.name] || {};
          return (
            <View key={item.name} style={styles.capabilityRow}>
              <View style={styles.linkLeft}>
                <Text style={styles.linkText}>{item.label}</Text>
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
        <Text style={styles.fieldHint}>开启的项才会随请求发送，未开启时使用服务端默认。</Text>
      </CollapsibleSection>
    </Card>
  );
}
