// W1/W2：工具调用卡片（工作区聊天流里的一条工具事实）。
//
// 为什么要它：在此之前工作区聊天只有「一行转瞬即逝的正在调用…」，一轮结束后工具调用
// **什么都看不到**——用户看不到模型读了哪些文件、改了哪个文件、命令输出了什么。
// W1 先把行投影做出来，W2（本文件）按工具族把行画成能看的卡片。
//
// 分派原则：**按「用户要认什么」分族**，不是每个工具一个组件——
//   edit  → 改了哪一行（find → replace 迷你 diff，红/绿）
//   write → 写了哪个文件、多大（覆盖写入没有旧内容可比，不假装有 diff）
//   shell/python → 命令/代码 + 可展开的输出
//   update_plan → 清单（勾选状态）
//   run_subagent → 子任务清单 + 结论
//   其余（read/search/git/…）→ 通用行：名字 + 参数摘要 + 状态 + 结果首行
//
// 两条纪律：**状态为 error 时不画「改动」**（失败的操作没有改动可言，画了就是撒谎）；
// 长内容一律折叠，默认只露摘要——聊天流不是日志面板。

import React, { useMemo, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme } from '../../theme/ThemeContext.js';
import { useTranslation } from '../../i18n/I18nContext.js';
import { argText } from '../conversation.js';

// 按工具族给图标（认得出「这一类在干什么」即可）。
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
  running: 'ellipsis-horizontal-circle',
});

function iconForTool(name) {
  if (TOOL_ICONS[name]) return TOOL_ICONS[name];
  if (String(name).startsWith('git_')) return 'git-branch-outline';
  return 'construct-outline';
}

export default function ToolCallRow({ tool }) {
  const { theme, fonts } = useTheme();
  const { t } = useTranslation();
  const styles = useMemo(() => createStyles(theme, fonts), [theme, fonts]);
  const [expanded, setExpanded] = useState(false);
  if (!tool) return null;

  const status = STATUS_ICONS[tool.status] ? tool.status : 'unknown';
  const statusColor = status === 'error'
    ? (theme.colors.danger || theme.colors.text)
    : (status === 'ok' ? theme.colors.primaryMuted : theme.colors.textFaint);
  // 卡片族由投影决定（见 conversation.js 的 toolCardKind）——组件只管画。
  const kind = tool.card || 'generic';
  const args = tool.argsRaw || null;

  const header = (
    <View style={styles.titleLine}>
      <Ionicons name={iconForTool(tool.name)} size={14} color={theme.colors.primaryMuted} />
      <Text style={styles.name} numberOfLines={1}>{tool.name}</Text>
      {tool.args ? <Text style={styles.args} numberOfLines={1}>{tool.args}</Text> : null}
      {status === 'running' ? <Text style={styles.running}>{t('workspace.chat.tool.running')}</Text> : null}
      <Ionicons name={STATUS_ICONS[status]} size={13} color={statusColor} />
    </View>
  );

  const body = renderBody({ kind, tool, args, expanded, styles, t });

  return (
    <View style={styles.card}>
      {body ? (
        <TouchableOpacity onPress={() => setExpanded(value => !value)} activeOpacity={0.8}>
          {header}
        </TouchableOpacity>
      ) : header}
      {body ? (expanded ? body : null) : null}
    </View>
  );
}

// 各族的卡片主体（都只在展开时渲染）。返回 null 表示这一族没有额外内容可看。
function renderBody({ kind, tool, args, expanded, styles, t }) {
  if (kind === 'edit') {
    // 失败的编辑没有「改动」可言——只在成功时画 find → replace。
    if (tool.status !== 'ok') return null;
    const find = argText(args, 'find', { max: 1200 });
    const replace = argText(args, 'replace', { max: 1200 });
    if (!find && !replace) return null;
    return (
      <View style={styles.body}>
        <Text style={styles.bodyLabel}>{t('workspace.chat.tool.change')}</Text>
        {String(find).split('\n').map((line, index) => (
          <Text key={`del-${index}`} style={[styles.diffLine, styles.diffDel]} numberOfLines={2}>{`- ${line}`}</Text>
        ))}
        {String(replace).split('\n').map((line, index) => (
          <Text key={`add-${index}`} style={[styles.diffLine, styles.diffAdd]} numberOfLines={2}>{`+ ${line}`}</Text>
        ))}
      </View>
    );
  }

  if (kind === 'write') {
    if (tool.status !== 'ok') return null;
    const content = argText(args, 'content', { max: 4000 });
    if (!content) return null;
    return (
      <View style={styles.body}>
        <Text style={styles.bodyLabel}>{t('workspace.chat.tool.content', { count: content.length })}</Text>
        <Text style={styles.mono} numberOfLines={expanded ? 40 : 3}>{content}</Text>
      </View>
    );
  }

  if (kind === 'command') {
    const command = argText(args, tool.name === 'run_python' ? 'code' : 'command', { max: 2000 });
    return (
      <View style={styles.body}>
        {command ? (
          <>
            <Text style={styles.bodyLabel}>
              {t(tool.name === 'run_python' ? 'workspace.chat.tool.code' : 'workspace.chat.tool.command')}
            </Text>
            <Text style={styles.mono} numberOfLines={expanded ? 30 : 2}>{command}</Text>
          </>
        ) : null}
        <Text style={styles.bodyLabel}>{t('workspace.chat.tool.output')}</Text>
        <Text style={styles.mono} numberOfLines={expanded ? 60 : 3}>
          {tool.resultText ? tool.resultText : t('workspace.chat.tool.noOutput')}
        </Text>
      </View>
    );
  }

  if (kind === 'plan') {
    const steps = Array.isArray(args && args.plan) ? args.plan : [];
    if (steps.length === 0) return null;
    const marks = { done: '[x]', in_progress: '[>]', pending: '[ ]' };
    return (
      <View style={styles.body}>
        <Text style={styles.bodyLabel}>{t('workspace.chat.tool.plan')}</Text>
        {steps.slice(0, expanded ? 20 : 6).map((item, index) => (
          <Text key={`step-${index}`} style={styles.mono} numberOfLines={2}>
            {`${marks[item && item.status] || '[ ]'} ${String((item && item.step) || '')}`}
          </Text>
        ))}
      </View>
    );
  }

  if (kind === 'subagent') {
    const tasks = Array.isArray(args && args.tasks) ? args.tasks : [];
    const first = tasks[0] && typeof tasks[0] === 'object' ? tasks[0] : null;
    const label = first ? String(first.task || first.prompt || first.name || '') : '';
    if (!label && !tool.resultPreview) return null;
    return (
      <View style={styles.body}>
        {label ? (
          <>
            <Text style={styles.bodyLabel}>{t('workspace.chat.tool.subtask')}</Text>
            <Text style={styles.mono} numberOfLines={expanded ? 6 : 2}>{label}</Text>
          </>
        ) : null}
        <Text style={styles.bodyLabel}>{t('workspace.chat.tool.output')}</Text>
        <Text style={styles.mono} numberOfLines={expanded ? 40 : 3}>
          {tool.resultText || t('workspace.chat.tool.noOutput')}
        </Text>
      </View>
    );
  }

  // 通用行：结果首行（W1 的行为，保持不变）。
  if (!tool.resultPreview) return null;
  return (
    <View style={styles.body}>
      <Text style={styles.preview} numberOfLines={expanded ? 12 : 1}>{tool.resultPreview}</Text>
    </View>
  );
}

const createStyles = (theme, fonts) => StyleSheet.create({
  card: {
    marginHorizontal: 12, marginBottom: 4, paddingVertical: 6, paddingHorizontal: 8,
    borderRadius: 8, backgroundColor: theme.colors.surfaceAlt,
  },
  titleLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  name: { color: theme.colors.text, fontSize: fonts.scaled(11.5) },
  args: { flex: 1, color: theme.colors.textMuted, fontSize: fonts.scaled(11) },
  running: { color: theme.colors.primaryMuted, fontSize: fonts.scaled(10.5) },
  body: { marginTop: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.divider, paddingTop: 6 },
  bodyLabel: { color: theme.colors.textMuted, fontSize: fonts.scaled(10.5), marginTop: 4, marginBottom: 2 },
  mono: { color: theme.colors.text, fontSize: fonts.scaled(11), fontFamily: 'monospace' },
  preview: { color: theme.colors.textFaint, fontSize: fonts.scaled(10.5) },
  diffLine: { fontSize: fonts.scaled(11), fontFamily: 'monospace' },
  diffDel: { color: theme.colors.danger || theme.colors.text },
  diffAdd: { color: theme.colors.success || theme.colors.primary },
});
