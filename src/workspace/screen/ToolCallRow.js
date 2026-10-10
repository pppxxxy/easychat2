// W1：工具调用行（工作区聊天流里的一条工具事实）。
//
// 为什么要有它：在此之前工作区聊天只有「一行转瞬即逝的正在调用…」，一轮结束后工具调用
// **什么都看不到**——用户看不到模型读了哪些文件、改了哪个文件、结果如何。这一行把
// 已沉淀的事实显示出来（W2 再按工具族做富卡片：内联 diff、输出折叠等）。
//
// 行数据来自 src/workspace/conversation.js 的投影，本组件只负责画：
//   名字 + 参数摘要（认得出这次调用干了什么）+ 状态 + 结果首行预览。

import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme } from '../../theme/ThemeContext.js';

// 按工具族给图标（认得出「这一类在干什么」即可，不追求逐个工具一个图标）。
const TOOL_ICONS = Object.freeze({
  read_workspace_file: 'document-text-outline',
  list_workspace_files: 'folder-open-outline',
  search_workspace: 'search-outline',
  write_workspace_file: 'create-outline',
  edit_workspace_file: 'create-outline',
  create_workspace_dir: 'folder-outline',
  update_plan: 'list-outline',
  run_shell: 'terminal-outline',
  run_python: 'logo-python',
  run_subagent: 'people-outline',
  run_remote_build: 'cloud-upload-outline',
  get_build_log: 'cloud-download-outline',
  materialize_repo: 'cloud-download-outline',
  export_workspace_docx: 'document-outline',
});

const STATUS_ICONS = Object.freeze({
  ok: 'checkmark-circle',
  error: 'alert-circle',
  unknown: 'help-circle',
});

function iconForTool(name) {
  if (TOOL_ICONS[name]) return TOOL_ICONS[name];
  if (String(name).startsWith('git_')) return 'git-branch-outline';
  return 'construct-outline';
}

export default function ToolCallRow({ tool }) {
  const { theme, fonts } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts), [theme, fonts]);
  if (!tool) return null;
  const status = STATUS_ICONS[tool.status] ? tool.status : 'unknown';
  const statusColor = status === 'error'
    ? (theme.colors.danger || theme.colors.text)
    : (status === 'ok' ? theme.colors.primaryMuted : theme.colors.textFaint);
  return (
    <View style={styles.row}>
      <Ionicons name={iconForTool(tool.name)} size={14} color={theme.colors.primaryMuted} />
      <View style={styles.body}>
        <View style={styles.titleLine}>
          <Text style={styles.name} numberOfLines={1}>{tool.name}</Text>
          {tool.args ? <Text style={styles.args} numberOfLines={1}>{tool.args}</Text> : null}
          <Ionicons name={STATUS_ICONS[status]} size={13} color={statusColor} />
        </View>
        {tool.resultPreview ? (
          <Text style={styles.preview} numberOfLines={1}>{tool.resultPreview}</Text>
        ) : null}
      </View>
    </View>
  );
}

const createStyles = (theme, fonts) => StyleSheet.create({
  row: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 6,
    marginHorizontal: 12, marginBottom: 4, paddingVertical: 6, paddingHorizontal: 8,
    borderRadius: 8, backgroundColor: theme.colors.surfaceAlt,
  },
  body: { flex: 1 },
  titleLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  name: { color: theme.colors.text, fontSize: fonts.scaled(11.5) },
  args: { flex: 1, color: theme.colors.textMuted, fontSize: fonts.scaled(11) },
  preview: { color: theme.colors.textFaint, fontSize: fonts.scaled(10.5), marginTop: 2 },
});
