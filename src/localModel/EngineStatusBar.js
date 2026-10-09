// 聊天层「本地引擎状态条」（v5 Stage C，D5）：输入栏上方一行，仅本地模型启用时出现。
// 状态来自 runtime.js（Stage A 的引擎广播）；本地失败静默回退在线时展示 10 秒警告。
// 点击跳模型中心（由调用方注入 onOpenHub）。

import React, { useEffect, useMemo, useState } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme } from '../theme/ThemeContext.js';
import { useTranslation } from '../i18n/I18nContext.js';
import { formatBytes } from '../utils/format.js';
import { getRuntimeState, subscribeRuntime } from './runtime.js';
import { ENGINE_TONE, deriveEngineStatus } from './engineStatus.js';
import { createChatStyles } from '../chat/chatStyles.js';

export default function EngineStatusBar({
  enabled = false,
  activeModelId = '',
  activeModelName = '',
  fallbackAt = 0,
  onOpenHub,
}) {
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
  const styles = useMemo(() => createChatStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const [runtime, setRuntime] = useState(() => getRuntimeState());
  // 「✕」本次隐藏（v5 设计稿画的关闭钮）：状态实质变化（换模型/换态）时重新出现，
  // 免得用户关掉后永远看不到引擎状态。
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => subscribeRuntime(setRuntime), []);

  const status = useMemo(() => deriveEngineStatus({
    enabled,
    activeModelId,
    activeModelName,
    runtime,
    fallbackAt,
  }), [enabled, activeModelId, activeModelName, runtime, fallbackAt]);

  const tone = status.tone;
  const modelName = status.modelName;
  useEffect(() => {
    setDismissed(false);
  }, [tone, modelName]);

  if (!status.visible || dismissed) return null;

  // 就绪 = 绿（success 语义色，对齐设计稿）；回退/出错整条切警示配色。
  const warn = status.tone === ENGINE_TONE.FALLBACK || status.tone === ENGINE_TONE.ERROR;
  const dotColor = status.tone === ENGINE_TONE.READY
    ? theme.colors.success
    : status.tone === ENGINE_TONE.LOADING
      ? theme.colors.primaryMuted
      : theme.colors.danger;

  const label = status.tone === ENGINE_TONE.FALLBACK
    ? t('localModel.engine.fallback', { name: status.modelName })
    : status.tone === ENGINE_TONE.LOADING
      ? t('localModel.engine.loading', { name: status.modelName, progress: status.progress })
      : status.tone === ENGINE_TONE.READY
        ? (status.ramBytes > 0
          ? t('localModel.engine.readyRam', { name: status.modelName, size: formatBytes(status.ramBytes) })
          : t('localModel.engine.ready', { name: status.modelName }))
        : status.tone === ENGINE_TONE.ERROR
          ? t('localModel.engine.error', { name: status.modelName })
          : t('localModel.engine.idle', { name: status.modelName });

  return (
    <TouchableOpacity
      style={[styles.engineBar, warn && styles.engineBarWarn]}
      onPress={onOpenHub}
      activeOpacity={0.8}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <View style={[styles.engineDot, { backgroundColor: dotColor }]} />
      <Text style={styles.engineText} numberOfLines={1}>{label}</Text>
      <Text style={styles.engineManage}>{t('localModel.engine.manage')}</Text>
      <TouchableOpacity
        style={styles.engineClose}
        onPress={() => setDismissed(true)}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        accessibilityRole="button"
        accessibilityLabel={t('localModel.engine.hide')}
      >
        <Ionicons name="close" size={14} color={theme.colors.textFaint} />
      </TouchableOpacity>
    </TouchableOpacity>
  );
}
