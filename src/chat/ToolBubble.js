// 聊天内工具调用的过程气泡（「🔧 正在搜索…」）。
//
// 只在用户开启「聊天内工具」且模型真的调用了工具时出现，随本轮生成结束一起消失
// （transient 消息，不落库、不进上下文）——它是过程提示，不是对话内容。
//
// 工具名与状态文案都走 i18n：本组件只做渲染，映射逻辑在 chat/toolBubbleView.js。

import React, { useMemo } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { toolBubbleView } from './toolBubbleView.js';
import { useTheme } from '../theme/ThemeContext.js';
import { useTranslation } from '../i18n/I18nContext.js';

export default function ToolBubble({ message }) {
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);

  const view = useMemo(() => toolBubbleView({
    name: message && message.toolName,
    status: (message && message.toolStatus) || 'running',
    error: (message && message.toolError) || '',
  }), [message]);

  if (!view) return null;

  const running = view.status === 'running';
  const failed = view.status === 'error';
  const tone = failed ? theme.colors.danger : (running ? theme.colors.primaryMuted : theme.colors.textFaint);

  return (
    <View style={styles.wrap}>
      <View style={styles.bubble}>
        {running ? (
          <ActivityIndicator size="small" color={tone} />
        ) : (
          <Ionicons
            name={failed ? 'alert-circle-outline' : 'checkmark-circle-outline'}
            size={13}
            color={tone}
          />
        )}
        <Text style={[styles.text, failed && styles.textFailed]} numberOfLines={2}>
          {`${t(view.nameKey, view.nameParams)} · ${t(view.statusKey)}`}
        </Text>
      </View>
      {failed && view.error ? (
        <Text style={styles.errorText} numberOfLines={2}>{view.error}</Text>
      ) : null}
    </View>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  wrap: { alignItems: 'flex-start', marginVertical: 2, paddingHorizontal: 16 },
  bubble: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: tokens.radius.pill,
    backgroundColor: theme.colors.surfaceAlt,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
  },
  text: {
    color: theme.colors.textMuted,
    fontSize: fonts.scaled(11),
    fontWeight: '700',
    marginLeft: 6,
  },
  textFailed: { color: theme.colors.danger },
  errorText: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(10),
    marginTop: 3,
    marginLeft: 10,
    maxWidth: '86%',
  },
});
