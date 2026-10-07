// 终端面板（v4 T1）。工作区单屏内的第五个领域：直接把命令打到应用私有沙盒里跑。
//
// 能力边界（如实标注，不装真终端）：
// - 命令走 plugins/shellExecutor（/system/bin/sh -c），工作目录固定在沙盒内；
// - 无 root 时只能访问应用沙盒与 /system/bin 等公开路径，碰不到 SAF 的 content://，
//   所以外部根下这个面板直接不可用（门控原因见 native.js 的 terminalGateReason）；
// - **没有流式输出**：ShellExecutor 在命令结束后一次性返回 stdout/stderr（原生模块没有
//   事件发射），所以长命令期间界面只有「运行中…」；要真终端的逐行回显需要新增流式原生模块；
// - 跑不了 vim/top 这类全屏交互程序；环境变量不跨命令保持（每条都是独立进程）；
// - cd 由面板维护（每条命令的 cwd 作为 ProcessBuilder 的工作目录传入），输出上限 64KB。
//
// 与 agent 的 run_shell 共用一个「允许执行命令」开关，但不逐条确认——命令是用户亲手输入的。

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme } from '../../theme/ThemeContext.js';
import { useTranslation } from '../../i18n/I18nContext.js';
import { getWorkspaceSettings } from '../../storage/workspace.js';
import { terminalGateReason, resolveTerminalSandboxRoot } from '../native.js';
import { execShellCommand, isShellAvailable, sandboxDirectoryPath, SHELL_TOOL_TIMEOUT_MS, truncateShellOutput } from '../shell.js';
import { historyWithCommand, resolveTerminalCwd, sandboxCwdPath } from '../terminal.js';

const FONT_STEPS = [11, 13, 15];
// 门控原因码 → 小写词条键（i18n 键名规范不允许大写）。
const GATE_KEYS = { SWITCH_OFF: 'switchOff', EXTERNAL_ROOT: 'externalRoot', SHELL_NOT_AVAILABLE: 'shellNotAvailable' };
let lineSeq = 0;
function nextLineId() {
  lineSeq += 1;
  return `term-${Date.now().toString(36)}-${lineSeq}`;
}

export default function TerminalPanel({ characterId }) {
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);

  const [gate, setGate] = useState('');
  const [cwd, setCwd] = useState('.');
  const [lines, setLines] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [fontStep, setFontStep] = useState(1);
  const sandboxRef = useRef('');
  const abortRef = useRef(null);
  const mountedRef = useRef(true);
  const scrollRef = useRef(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (abortRef.current) abortRef.current.abort();
    };
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const settings = await getWorkspaceSettings();
        if (!alive) return;
        const shellAvailable = isShellAvailable();
        setGate(terminalGateReason(settings, { shellAvailable }));
        sandboxRef.current = resolveTerminalSandboxRoot(settings, { shellAvailable }) || '';
      } catch (error) {
        if (alive) setGate('SHELL_NOT_AVAILABLE');
      }
    })();
    return () => { alive = false; };
  }, []);

  const appendLine = useCallback(entry => {
    if (mountedRef.current) setLines(prev => [...prev, { id: nextLineId(), ...entry }].slice(-200));
  }, []);

  const run = useCallback(async () => {
    const command = input.trim();
    if (!command || busy || gate !== '') return;
    setHistory(prev => historyWithCommand(prev, command));
    setHistoryIndex(-1);
    setInput('');

    // cd 由面板处理：每条命令是独立进程，工作目录靠 cwdPath 传下去。
    const nextCwd = resolveTerminalCwd(cwd, command);
    if (nextCwd.changed) {
      setCwd(nextCwd.cwd);
      appendLine({ command, stdout: '', stderr: '', exitCode: 0, note: 'cwd', cwd: nextCwd.cwd });
      return;
    }

    const sandbox = sandboxRef.current;
    if (!sandbox) {
      appendLine({ command, stdout: '', stderr: t('workspace.terminal.err.noSandbox'), exitCode: -1, isError: true });
      return;
    }
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const result = await execShellCommand({
        command,
        // 与文件工具同一沙盒：根 + 角色子目录，终端看到的就是该角色的工作区。
        cwdPath: sandboxCwdPath(sandboxDirectoryPath(sandbox, characterId), cwd),
        signal: controller.signal,
        timeoutMs: SHELL_TOOL_TIMEOUT_MS,
      });
      const stdout = truncateShellOutput(result.stdout);
      const stderr = truncateShellOutput(result.stderr);
      appendLine({
        command,
        stdout: stdout.text,
        stderr: stderr.text,
        exitCode: Number.isFinite(result.exitCode) ? result.exitCode : -1,
        timedOut: result.timedOut === true,
        truncated: stdout.truncated || stderr.truncated,
      });
    } catch (error) {
      const canceled = Boolean(error && (error.canceled || error.name === 'AbortError'));
      appendLine({
        command,
        stdout: '',
        stderr: canceled ? t('workspace.terminal.killed') : ((error && error.message) || t('workspace.terminal.err.run')),
        exitCode: -1,
        canceled,
        isError: !canceled,
      });
    } finally {
      if (mountedRef.current) setBusy(false);
      abortRef.current = null;
    }
  }, [appendLine, busy, characterId, cwd, gate, input, t]);

  const kill = useCallback(() => {
    if (abortRef.current) abortRef.current.abort();
  }, []);

  const recallHistory = useCallback(direction => {
    if (!history.length) return;
    const base = historyIndex === -1 ? history.length : historyIndex;
    const next = Math.min(history.length - 1, Math.max(0, base + direction));
    setHistoryIndex(next);
    setInput(history[next]);
  }, [history, historyIndex]);

  const canRun = gate === '' && !busy && input.trim().length > 0;

  return (
    <View style={styles.container}>
      {/* 顶栏：cwd 面包屑 + 清屏 + 字号 */}
      <View style={styles.bar}>
        <Ionicons name="terminal-outline" size={15} color={theme.colors.primarySoft} />
        <Text style={styles.cwd} numberOfLines={1}>
          {t('workspace.terminal.cwd', { path: cwd === '.' ? '/' : `/${cwd}` })}
        </Text>
        <TouchableOpacity
          style={styles.barButton}
          onPress={() => setFontStep(step => (step + 1) % FONT_STEPS.length)}
          accessibilityLabel={t('workspace.terminal.fontSize')}
        >
          <Text style={styles.barButtonText}>{FONT_STEPS[fontStep]}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.barButton}
          onPress={() => setLines([])}
          accessibilityLabel={t('workspace.terminal.clear')}
        >
          <Ionicons name="trash-outline" size={15} color={theme.colors.textMuted} />
        </TouchableOpacity>
      </View>

      {gate !== '' ? (
        <View style={styles.gateBox}>
          <Text style={styles.gateTitle}>{t('workspace.terminal.gate.title')}</Text>
          <Text style={styles.gateBody}>{t(`workspace.terminal.gate.${GATE_KEYS[gate] || 'shellNotAvailable'}`)}</Text>
        </View>
      ) : null}

      <ScrollView
        ref={scrollRef}
        style={styles.output}
        contentContainerStyle={styles.outputContent}
        onContentSizeChange={() => { if (scrollRef.current && scrollRef.current.scrollToEnd) scrollRef.current.scrollToEnd({ animated: false }); }}
      >
        {lines.length === 0 ? (
          <Text style={[styles.hintText, { fontSize: FONT_STEPS[fontStep] }]}>{t('workspace.terminal.empty')}</Text>
        ) : null}
        {lines.map(line => (
          <View key={line.id} style={styles.line}>
            <Text style={[styles.command, { fontSize: FONT_STEPS[fontStep] }]} numberOfLines={2}>
              {'$ '}{line.command}
            </Text>
            {line.note === 'cwd' ? (
              <Text style={[styles.note, { fontSize: FONT_STEPS[fontStep] - 1 }]}>
                {t('workspace.terminal.cwdChanged', { path: line.cwd === '.' ? '/' : `/${line.cwd}` })}
              </Text>
            ) : null}
            {line.stdout ? <Text style={[styles.stdout, { fontSize: FONT_STEPS[fontStep] }]}>{line.stdout}</Text> : null}
            {line.stderr ? <Text style={[styles.stderr, { fontSize: FONT_STEPS[fontStep] }]}>{line.stderr}</Text> : null}
            {line.note !== 'cwd' && line.exitCode !== 0 && !line.canceled ? (
              <Text style={[styles.note, { fontSize: FONT_STEPS[fontStep] - 1 }]}>
                {line.timedOut
                  ? t('workspace.terminal.timedOut')
                  : t('workspace.terminal.exitCode', { code: line.exitCode })}
              </Text>
            ) : null}
            {line.truncated ? (
              <Text style={[styles.note, { fontSize: FONT_STEPS[fontStep] - 1 }]}>{t('workspace.terminal.truncated')}</Text>
            ) : null}
          </View>
        ))}
        {busy ? (
          <View style={styles.running}>
            <ActivityIndicator size="small" color={theme.colors.primaryMuted} />
            <Text style={styles.runningText}>{t('workspace.terminal.running')}</Text>
          </View>
        ) : null}
      </ScrollView>

      {/* 虚拟键一排：↑ ↓ CTRL+C（真强杀） */}
      <View style={styles.keyRow}>
        <TouchableOpacity style={styles.key} onPress={() => recallHistory(-1)} disabled={!history.length}>
          <Ionicons name="chevron-up" size={16} color={theme.colors.primarySoft} />
        </TouchableOpacity>
        <TouchableOpacity style={styles.key} onPress={() => recallHistory(1)} disabled={!history.length}>
          <Ionicons name="chevron-down" size={16} color={theme.colors.primarySoft} />
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.key, styles.keyWide, !busy && styles.keyDisabled]}
          onPress={kill}
          disabled={!busy}
          accessibilityLabel={t('workspace.terminal.kill')}
        >
          <Text style={styles.keyText}>CTRL+C</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.inputBar}>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          onSubmitEditing={run}
          placeholder={t('workspace.terminal.placeholder')}
          placeholderTextColor={theme.colors.textFaint}
          editable={gate === '' && !busy}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="send"
        />
        <TouchableOpacity
          style={[styles.sendButton, !canRun && styles.sendButtonDisabled]}
          onPress={run}
          disabled={!canRun}
          accessibilityLabel={t('workspace.terminal.run')}
        >
          <Ionicons name="arrow-up" size={18} color={theme.colors.text} />
        </TouchableOpacity>
      </View>

      <Text style={styles.boundary} numberOfLines={3}>{t('workspace.terminal.boundary')}</Text>
    </View>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  container: { flex: 1 },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderBottomWidth: tokens.border.thin,
    borderBottomColor: theme.colors.divider,
  },
  cwd: { flex: 1, color: theme.colors.textMuted, fontSize: fonts.scaled(12), marginHorizontal: 6 },
  barButton: { paddingHorizontal: 8, paddingVertical: 2 },
  barButtonText: { color: theme.colors.textMuted, fontSize: fonts.scaled(12), fontWeight: '700' },
  gateBox: {
    margin: 12,
    padding: 12,
    borderRadius: tokens.radius.sm,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    backgroundColor: theme.colors.surface,
  },
  gateTitle: { color: theme.colors.text, fontSize: fonts.scaled(13), fontWeight: '700', marginBottom: 4 },
  gateBody: { color: theme.colors.textMuted, fontSize: fonts.scaled(12), lineHeight: fonts.scaled(18) },
  output: { flex: 1 },
  outputContent: { paddingHorizontal: 12, paddingVertical: 10 },
  hintText: { color: theme.colors.textFaint, lineHeight: fonts.scaled(18) },
  line: { marginBottom: 10 },
  command: { color: theme.colors.primary, fontFamily: 'monospace' },
  stdout: { color: theme.colors.text, fontFamily: 'monospace' },
  stderr: { color: theme.colors.danger, fontFamily: 'monospace' },
  note: { color: theme.colors.textFaint, fontFamily: 'monospace' },
  running: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
  runningText: { color: theme.colors.textMuted, fontSize: fonts.scaled(11), marginLeft: 6 },
  keyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingBottom: 6,
  },
  key: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: tokens.radius.sm,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    backgroundColor: theme.colors.surface,
    marginRight: 8,
  },
  keyWide: { paddingHorizontal: 14 },
  keyDisabled: { opacity: 0.4 },
  keyText: { color: theme.colors.textMuted, fontSize: fonts.scaled(11), fontWeight: '700' },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'center',
    borderTopWidth: tokens.border.thin,
    borderTopColor: theme.colors.surfaceBorder,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: 8,
    paddingVertical: 8,
  },
  input: { flex: 1, color: theme.colors.text, fontSize: fonts.scaled(13), fontFamily: 'monospace', paddingHorizontal: 6, paddingVertical: 4 },
  sendButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: theme.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendButtonDisabled: { opacity: 0.5 },
  boundary: { color: theme.colors.textFaint, fontSize: fonts.scaled(10), paddingHorizontal: 12, paddingBottom: 8 },
});
