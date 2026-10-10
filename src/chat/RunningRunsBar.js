// 运行中角色条（L 系 ③，spec 2026-10-10-runtime-split）。
//
// 显示**非当前会话**正在后台生成的运行，提供「停止」与「切过去」两个动作。
// 当前会话的运行不在这里显示——它由输入区的「停止」按钮体现，重复显示只会占地方。
//
// 数据源是应用级登记表 sessionRuns（发送路径在 useSessionGuard 里登记），
// 与 UI 无耦合：即便聊天页没显示某个会话，它的运行也照常出现在这里。

import React, { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { sessionRuns } from '../agent/runtime/sessionRuns.js';
import { useTranslation } from '../i18n/I18nContext.js';
import { useTheme } from '../theme/ThemeContext.js';

export default function RunningRunsBar({ activeSessionId, characters, onOpen, onStop }) {
  const { t } = useTranslation();
  const { theme } = useTheme();
  const [runs, setRuns] = useState(() => sessionRuns.list());

  useEffect(() => {
    // 订阅登记表：任何会话开始/结束/取消都会推来最新快照。
    setRuns(sessionRuns.list());
    return sessionRuns.subscribe(snapshot => setRuns(snapshot));
  }, []);

  const activeId = String(activeSessionId || '');
  const others = (Array.isArray(runs) ? runs : []).filter(run => run && run.sessionId !== activeId);
  if (others.length === 0) return null;

  const nameOf = run => {
    const list = Array.isArray(characters) ? characters : [];
    const found = list.find(item => item && item.id === run.characterId);
    return String((found && found.name) || run.label || '').trim() || t('chat.running.unknown');
  };

  return (
    <View style={[styles.bar, { backgroundColor: theme.colors.surfaceAlt, borderColor: theme.colors.divider }]}>
      <Text style={[styles.label, { color: theme.colors.textFaint }]} numberOfLines={1}>
        {t('chat.running.title')}
      </Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
        {others.map(run => (
          <TouchableOpacity
            key={run.sessionId}
            style={[styles.chip, { borderColor: theme.colors.divider, backgroundColor: theme.colors.surface }]}
            onPress={() => onOpen && onOpen(run.sessionId)}
            accessibilityRole="button"
            accessibilityLabel={t('chat.running.a11y.open', { name: nameOf(run) })}
          >
            <Text style={[styles.chipText, { color: theme.colors.text }]} numberOfLines={1}>
              {nameOf(run)}
            </Text>
            <TouchableOpacity
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              onPress={() => onStop && onStop(run.sessionId)}
              accessibilityRole="button"
              accessibilityLabel={t('chat.running.stop')}
            >
              <Ionicons name="close-circle" size={16} color={theme.colors.textFaint} />
            </TouchableOpacity>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    borderTopWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  label: { fontSize: 11, fontWeight: '600', marginRight: 8 },
  row: { alignItems: 'center', gap: 8 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 14,
    paddingLeft: 10,
    paddingRight: 6,
    paddingVertical: 3,
    maxWidth: 180,
  },
  chipText: { fontSize: 12, marginRight: 6, flexShrink: 1 },
});
