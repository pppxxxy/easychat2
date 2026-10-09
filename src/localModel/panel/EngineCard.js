// 模型中心「运行状态卡」（v5 Stage C）：读 runtime 单例（与聊天层引擎状态条同源），
// 常驻模型库页顶。展示 就绪/加载/失败 三态、内存占用、会话 KV 计数与下载来源；
// 就绪时给一键卸载入口，并链接运行日志。纯渲染，数据由壳装配。

import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { formatBytes } from '../../utils/format.js';
import { getLoadedConversationCount } from '../adapter.js';

function sourceLabel(entry, t) {
  if (!entry) return t('localModel.source.unknown');
  if (entry.imported) return t('localModel.source.imported');
  const id = String(entry.sourceId || '');
  if (id === 'huggingface') return t('localModel.source.huggingface');
  if (id === 'hf-mirror') return t('localModel.source.hfMirror');
  if (id === 'modelscope') return t('localModel.source.modelscope');
  return t('localModel.source.unknown');
}

export default function EngineCard({ styles, theme, t, runtime, entries, onUnloadModel, onOpenLogs }) {
  if (!runtime || runtime.status === 'idle') return null;
  const activeItem = entries.find(item => item.id === runtime.modelId) || null;
  const activeName = (activeItem && activeItem.name) || runtime.modelId;
  const ready = runtime.status === 'ready';

  const headText = ready
    ? t('localModel.run.running', { name: activeName })
    : runtime.status === 'loading'
      ? t('localModel.engine.cardLoading', { progress: runtime.progress })
      : t('localModel.engine.cardError');
  const metaText = ready
    ? t('localModel.run.meta', {
      size: formatBytes(runtime.ramEstimate) || '—',
      count: getLoadedConversationCount(),
      source: sourceLabel(activeItem, t),
    })
    : '';
  // 三态配色（v5 设计稿）：就绪=绿（success）、加载中=品牌色、失败=红。
  const loading = runtime.status === 'loading';
  const cardStyle = ready ? styles.runCardReady : loading ? styles.runCardLoading : styles.runCardError;
  const dotStyle = ready ? styles.runDotReady : loading ? styles.runDotLoading : styles.runDotError;

  return (
    <View style={[styles.runCard, cardStyle]}>
      <View style={styles.runHead}>
        <View style={styles.runNameWrap}>
          <View style={[styles.runDot, dotStyle]} />
          <Text style={styles.runName} numberOfLines={1}>{headText}</Text>
        </View>
        {ready ? (
          <Text style={[styles.runBadge, styles.runBadgeReady]} numberOfLines={1}>{t('localModel.badge.installed')}</Text>
        ) : null}
      </View>
      {metaText ? <Text style={styles.runMeta} numberOfLines={1}>{metaText}</Text> : null}
      <View style={styles.runActions}>
        {ready ? (
          <TouchableOpacity
            style={styles.runButton}
            onPress={onUnloadModel}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel={t('localModel.engine.unloadA11y')}
          >
            <Ionicons name="power-outline" size={13} color={theme.colors.dangerSoft} />
            <Text style={[styles.runButtonText, styles.runButtonDanger]}>{t('localModel.engine.unload')}</Text>
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity
          style={styles.runButton}
          onPress={onOpenLogs}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityLabel={t('localModel.engine.logsA11y')}
        >
          <Ionicons name="document-text-outline" size={13} color={theme.colors.primarySoft} />
          <Text style={styles.runButtonText}>{t('localModel.engine.logs')}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}