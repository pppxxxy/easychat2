// 模型中心「运行状态卡」（v5 Stage C）：读 runtime 单例（与聊天层引擎状态条同源），
// 常驻模型库页顶；就绪时给一键卸载入口，并链接运行日志。纯渲染，数据由壳装配。

import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { formatBytes } from '../../utils/format.js';

export default function EngineCard({ styles, theme, t, runtime, entries, onUnloadModel, onOpenLogs }) {
  if (!runtime || runtime.status === 'idle') return null;
  const activeName = (entries.find(item => item.id === runtime.modelId) || {}).name || runtime.modelId;
  const label = runtime.status === 'ready'
    ? t('localModel.engine.cardReady', { name: activeName, size: formatBytes(runtime.ramEstimate) || '—' })
    : runtime.status === 'loading'
      ? t('localModel.engine.cardLoading', { progress: runtime.progress })
      : t('localModel.engine.cardError');
  return (
    <View style={styles.engineCard}>
      <View style={styles.activeRow}>
        <Text style={styles.activeText} numberOfLines={1}>{label}</Text>
        {runtime.status === 'ready' ? (
          <TouchableOpacity
            style={styles.searchModelButton}
            onPress={onUnloadModel}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel={t('localModel.engine.unloadA11y')}
          >
            <Text style={styles.searchModelText}>{t('localModel.engine.unload')}</Text>
          </TouchableOpacity>
        ) : null}
      </View>
      <TouchableOpacity
        style={styles.resetAll}
        onPress={onOpenLogs}
        activeOpacity={0.8}
        accessibilityRole="button"
        accessibilityLabel={t('localModel.engine.logsA11y')}
      >
        <Ionicons name="document-text-outline" size={13} color={theme.colors.primarySoft} />
        <Text style={styles.resetAllText}>{t('localModel.engine.logs')}</Text>
      </TouchableOpacity>
    </View>
  );
}
