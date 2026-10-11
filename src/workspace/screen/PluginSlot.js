// 插件槽位渲染（PluginSlot）——「可注册 UI」的渲染端。
//
// 注册端在 plugins/registry.js（谁注册谁负责），渲染端在这里：给一个槽位 kind 与贡献列表，
// 按 kind 画出来。于是「对话头部多一个徽标 / 设置面板多一行」不再取决于改哪个大文件，
// 而取决于谁注册了。纯展示组件，不含业务逻辑。
//
// 说明：RN UI 文件，已登记进 .c8rc.json 排除。

import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme } from '../../theme/ThemeContext.js';

const KIND_ICON = Object.freeze({
  'chat.header': 'pricetag-outline',
  'chat.footer': 'pricetag-outline',
  'settings.row': 'extension-puzzle-outline',
  'files.toolbar': 'hammer-outline',
  'message.action': 'flash-outline',
  'composer.button': 'add-circle-outline',
});

export default function PluginSlot({ kind, contributions = [], onAction = null }) {
  const { theme, fonts } = useTheme();
  const styles = React.useMemo(() => createStyles(theme, fonts), [theme, fonts]);
  const list = Array.isArray(contributions) ? contributions : [];
  if (list.length === 0) return null;
  return (
    <View style={styles.wrap}>
      {list.map(item => {
        const label = item.label || item.id || kind;
        const body = item.text || '';
        const canAct = typeof onAction === 'function' && item.action;
        return (
          <TouchableOpacity
            key={`${kind}:${item.id || label}`}
            style={styles.row}
            activeOpacity={canAct ? 0.7 : 1}
            onPress={canAct ? () => onAction(item.action, item) : undefined}
            disabled={!canAct}
          >
            <Ionicons
              name={KIND_ICON[kind] || 'extension-puzzle-outline'}
              size={14}
              color={theme.colors.primary}
            />
            <View style={styles.textWrap}>
              <Text style={styles.label} numberOfLines={1}>{label}</Text>
              {body ? <Text style={styles.body} numberOfLines={2}>{body}</Text> : null}
            </View>
            {canAct ? <Ionicons name="chevron-forward" size={14} color={theme.colors.textFaint} /> : null}
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const createStyles = (theme, fonts) => StyleSheet.create({
  wrap: { gap: 6 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 10, paddingVertical: 8, borderRadius: 8,
    backgroundColor: theme.colors.surface,
  },
  textWrap: { flex: 1 },
  label: { color: theme.colors.text, fontSize: fonts.scaled(13), fontWeight: '600' },
  body: { color: theme.colors.textMuted, fontSize: fonts.scaled(11.5), marginTop: 2 },
});
