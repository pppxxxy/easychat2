// 插件槽位渲染（PluginSlot）——「可注册 UI」的渲染端。
//
// 注册端在 **workspace/plugins/registry.js**（谁注册谁负责；注意别与 src/plugins/registry.js
// 混了——那是联网搜索插件，与 UI 槽位无关）。渲染端在这里：给一个槽位 kind 与贡献列表，
// 按 kind 画出来。于是「对话头部多一个徽标 / 设置面板多一行」不再取决于改哪个大文件，
// 而取决于谁注册了。纯展示组件，不含业务逻辑。
//
// 「能画」不等于「有地方画」：真正决定某个 kind 会不会出现在界面上的，是下面那张
// SLOT_RENDER_POINTS 接线表（谁在哪里挂了 `<PluginSlot kind=... />`）。缺了落点的 kind
// 注册得再成功也永远不显示，所以未接线的一律显式标 null 并由插件面板如实列出。
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

// 槽位接线表：kind → **真实渲染点**（哪个文件里写了 `<PluginSlot kind="..." />`）。
// null = 已可注册、校验通过，但界面上**没有落点**——「注册成功却永不显示」是插件系统里
// 最难发现的假接线：manifest 收下了、注册表也 render 出来了，用户却永远看不到，而且不报错。
// 此前 6 种 kind 里只有 settings.row 真接了线（其余 5 种只在测试里 render 过），本表把这件事
// 如实写下来，tests/plugins.test.mjs 断言「manifest 声明的每种 kind 都在表里有归属」——
// 新增 kind 时必须选一边（接线，或在这里显式标 null 并由插件面板如实列出），不会再默默漏掉。
export const SLOT_RENDER_POINTS = Object.freeze({
  'chat.header': null,   // 对话面板顶部徽标行：暂无挂载点
  'chat.footer': null,   // 输入区上方：暂无挂载点
  'settings.row': 'src/extension/WorkspacePluginsPanel.js', // 唯一已接线：插件面板的槽位演示区
  'files.toolbar': null, // 文件面板工具条：暂无挂载点
  'message.action': null, // 消息气泡动作按钮：暂无挂载点
  'composer.button': null, // 输入框旁按钮：暂无挂载点
});

// 未接线的 kind（**派生**，别再手写第二份）：插件面板据此把它们如实列出来。
export const UNWIRED_SLOT_KINDS = Object.freeze(
  Object.keys(SLOT_RENDER_POINTS).filter(kind => !SLOT_RENDER_POINTS[kind]),
);

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
