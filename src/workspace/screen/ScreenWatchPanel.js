// SW1：工作区左栏「看屏幕」领域面板。
//
// 为什么要有它：screenWatch 原先只有聊天角色一条路（线程绑 characterId），
// 工作区助手想看屏幕得绕去「记忆 → 屏幕对话」再切角色，且线程与聊天场景混在一处。
// 本面板把工作区侧的入口开在左栏（与历史同属「回看」性质，排在它旁边），
// 三块内容：
//   ① 悬浮窗状态（支持性 / 悬浮权限 / 运行中）——复用 overlay.js 的能力查询与降级文案；
//   ② 「开始工作区会话」按钮——开启悬浮窗并落到工作区 scope 的线程；
//   ③ 工作区线程列表（scope='workspace'，点开续聊）。
//
// 边界（如实标注）：
// - SW1 只做「线程分类 + 入口」；会话真正接**工作区 agent 管线**（工具集/权限门控）
//   是 SW2 的事——在那之前，本面板的会话仍走聊天角色管线（与既有 screenWatch 一致），
//   只是线程被标记为 workspace scope，不会与聊天线程串上下文。
// - SW2/SW3 完成后，本面板的「开始会话」会经 pullController 同款的模块级控制器
//   驱动悬浮窗 mini 聊天（原生只做嘴和眼）。

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
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
import {
  canDrawOverlays,
  ensurePermissionThenStart,
  isOverlaySupported,
  OVERLAY_START_RESULT,
  stopOverlay,
} from '../../screenWatch/overlay.js';
import useOverlayActive from '../../screenWatch/useOverlayActive.js';
import {
  appendThreadEntry,
  deleteScreenWatchThread,
  getOrCreateActiveThread,
  getScreenWatchThreads,
  THREAD_SCOPE_WORKSPACE,
} from '../../screenWatch/threads.js';
import { formatThreadEntryTime, threadEntryRoleKey } from '../../screenWatch/threadEntries.js';
import { screenThreadPreview } from '../../memory/memoryBuckets.js';
import { readImageDataUri } from '../../chat/attachments.js';
import { approveToolCall, readToolPermissionRules } from '../../chat/toolApprovalFlow.js';
import { readHookPermissionRules } from '../../workspace/hooks.js';
import { runWorkspaceWatchTurn } from '../../screenWatch/workspaceWatchTurn.js';
import { runHeadlessAgent } from '../../workspace/headlessAgent.js';

// SW2：工作区看屏幕会话的**模式**。看屏幕的典型用途是「看着屏幕问/让它动手」，
// 默认 read（只读工具直接跑，写工具根本不在工具表里——最安全）；用户显式切 write
// 才会带写工具，且每次破坏性调用都经 approveToolCall 确认。
const WATCH_MODES = ['read', 'write'];

// SW1 只做线程分类与入口；SW2 起接工作区 agent 管线（storeRef 用于权限规则与线程落库）。
export default function ScreenWatchPanel({ storeRef }) {
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);

  const [supported, setSupported] = useState(true);
  const [permitted, setPermitted] = useState(true);
  // FEAT-AC5 P0-B：悬浮窗状态改为共用 hook——挂载查询 + 事件推送 + **回前台对账**。
  // 原先这里只在挂载时查一次，用户从悬浮窗自己的「关闭」关掉后（app 在后台，
  // 原生事件被 ROM 冻结丢失），状态行会永久停在「关闭悬浮窗」。
  const { active, setActive, reconcile } = useOverlayActive();
  const [threads, setThreads] = useState([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  // SW2：指令输入 + 当前会话（工作区 scope）+ 本轮运行状态。
  const [command, setCommand] = useState('');
  const [thread, setThread] = useState(null);
  const [running, setRunning] = useState(false);
  const [reply, setReply] = useState('');
  const [mode, setMode] = useState('read');
  // FEAT-AC5 P0-A：展开了哪一场对话（null = 全部收起）。
  // 面板内展开而非独立路由：记忆页 MemoryScreen 的会话详情展开是仓内先例，
  // 而工作区面板本就是「回看」性质，跳走再回来会丢掉指令输入框里的草稿。
  const [expandedId, setExpandedId] = useState('');
  const abortRef = useRef(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (abortRef.current) abortRef.current.abort();
    };
  }, []);

  // 状态与线程列表一起刷新：悬浮窗状态来自原生，线程来自存储。
  const refresh = useCallback(async () => {
    setSupported(isOverlaySupported());
    try {
      setPermitted(await canDrawOverlays());
    } catch (error) {
      setPermitted(false);
    }
    // 状态走 hook 的对账（三态：读不到就维持现状，不把「查失败」画成「未开启」）。
    await reconcile();
    try {
      const list = await getScreenWatchThreads();
      setThreads((Array.isArray(list) ? list : []).filter(item => item && item.scope === THREAD_SCOPE_WORKSPACE));
    } catch (error) {
      // 读不到 ≠ 没有（与 useScreenWatchThreads 的三态口径一致）：如实说，不假装空列表。
      setThreads([]);
      setNote(t('workspace.watch.readFailed'));
    }
  }, [reconcile, t]);

  useEffect(() => {
    let alive = true;
    (async () => { if (alive) await refresh(); })();
    return () => { alive = false; };
  }, [refresh]);

  const toggleOverlay = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setNote('');
    try {
      if (active) {
        await stopOverlay();
        setActive(false);
      } else {
        // FIX-3：两个入口统一走 ensurePermissionThenStart，不再各自为政。
        // 调用方据此给出具体原因码和可处置的提示（授权失效/未开启等）。
        const result = await ensurePermissionThenStart();
        if (!result.ok) {
          // 失败原因分档 → 对应的文案键（i18n 词条待补）。
          const reasonKey = {
            [OVERLAY_START_RESULT.UNSUPPORTED]: 'workspace.watch.unsupported',
            [OVERLAY_START_RESULT.OVERLAY_PERMISSION]: 'workspace.watch.permissionDenied',
            [OVERLAY_START_RESULT.CAPTURE_PERMISSION]: 'workspace.watch.capturePermissionRequired',
            [OVERLAY_START_RESULT.START_FAILED]: 'workspace.watch.startFailed',
          }[result.reason] || 'workspace.watch.startFailed';
          setNote(t(reasonKey));
          return;
        }
        setActive(true);
      }
      await refresh();
    } catch (error) {
      setNote(t('workspace.watch.startFailed'));
    } finally {
      setBusy(false);
    }
  }, [active, busy, permitted, refresh, t]);

  const unsupported = !supported;

  // FEAT-AC5 P0-A：点一下展开/收起这一场对话（面板内展开，不跳路由）。
  const toggleThread = useCallback(threadId => {
    const id = String(threadId || '');
    if (!id) return;
    setExpandedId(current => (current === id ? '' : id));
  }, []);

  // FEAT-AC5 P0-A：删除一场对话。
  // 破坏性操作走 Alert 二次确认——这里是 **app 面板内**，不受悬浮窗「不弹全屏框」的限制
  //（那条限制只对悬浮窗成立，见 overlayConfirm.js 的文件头）。
  // 失败必须说出来：静默失败会让用户以为删掉了（useScreenWatchThreads 的既有口径同此）。
  const confirmDeleteThread = useCallback(item => {
    if (!item || !item.id) return;
    const name = String(item.characterName || '').trim() || t('workspace.watch.assistantName');
    Alert.alert(
      t('workspace.watch.deleteThread.title'),
      t('workspace.watch.deleteThread.body', { name }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: () => {
            deleteScreenWatchThread(item.id)
              .then(() => {
                // 删掉的正好是展开中的那场 → 收起，否则展开态指向一个已不存在的 id。
                setExpandedId(current => (current === item.id ? '' : current));
                return refresh();
              })
              .catch(error => {
                if (!mountedRef.current) return;
                setNote((error && error.message) || t('common.error.deleteFailed'));
              });
          },
        },
      ]
    );
  }, [refresh, t]);

  // SW2：跑一轮工作区看屏幕会话——接 agent 管线（工具集 + 权限门控），
  // 破坏性操作经 approveToolCall 弹确认（无确认 = 拒绝，绝不放行）。
  const submitCommand = useCallback(async () => {
    const said = String(command || '').trim();
    if (!said || running) return;
    setRunning(true);
    setNote('');
    setReply('');
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      // 工作区 scope 的活跃线程（与聊天线程隔离；30 分钟空闲后自动开新的）。
      const created = await getOrCreateActiveThread('workspace', t('workspace.watch.assistantName'), Date.now(), THREAD_SCOPE_WORKSPACE)
        .catch(() => null);
      const activeThread = created ? created.thread : thread;
      if (mountedRef.current) setThread(activeThread);
      const result = await runWorkspaceWatchTurn({
        userText: said,
        thread: activeThread,
        mode,
        signal: controller.signal,
        runAgent: payload => runHeadlessAgent({
          ...payload,
          allowWrite: mode === 'write',
        }),
        // 破坏性操作确认：复用工作区聊天的审批流（规则求值 + 三选项框 + 记住选择）。
        confirm: call => approveToolCall({
          name: call && call.name,
          args: call && call.args,
          t,
          signal: controller.signal,
        }),
        // 权限规则（hooks.json + 用户存储）：与工作区聊天同一条合并入口——
        // 不接这条，写工具上的手写 deny 在看屏幕会话里会变成死键（P0-2）。
        permissionRules: async () => readToolPermissionRules(
          await readHookPermissionRules(storeRef && storeRef.current, 'workspace')
        ),
        readFrame: readImageDataUri,
        appendEntry: appendThreadEntry,
        onToolEvent: event => {
          if (!mountedRef.current || !event) return;
          if (event.phase === 'start' && event.name) {
            setNote(t('workspace.watch.toolRunning', { name: event.name }));
          }
        },
        t,
      });
      if (!mountedRef.current) return;
      if (result.ok) {
        setReply(result.text);
        setCommand('');
      } else if (result.error) {
        setNote(result.error);
      }
      await refresh();
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      if (mountedRef.current) setRunning(false);
    }
  }, [command, mode, refresh, running, t, thread]);

  const stopCommand = useCallback(() => {
    if (abortRef.current) abortRef.current.abort();
    setRunning(false);
  }, []);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.body}>
      <Text style={styles.title}>{t('workspace.watch.title')}</Text>
      <Text style={styles.hint}>{t('workspace.watch.subtitle')}</Text>

      {/* ① 悬浮窗状态：能力 / 权限 / 运行中三态如实呈现（不可用时给降级说明）。 */}
      <View style={styles.card}>
        <View style={styles.statusRow}>
          <Ionicons
            name={active ? 'radio-outline' : 'radio-button-off-outline'}
            size={18}
            color={active ? theme.colors.primary : theme.colors.textMuted}
          />
          <Text style={styles.statusText} numberOfLines={2}>
            {unsupported
              ? t('workspace.watch.unsupported')
              : (active ? t('workspace.watch.statusOn') : t('workspace.watch.statusOff'))}
          </Text>
        </View>
        <TouchableOpacity
          style={[styles.action, (busy || unsupported) && styles.actionDisabled]}
          onPress={toggleOverlay}
          disabled={busy || unsupported}
          accessibilityRole="button"
        >
          {busy ? <ActivityIndicator size="small" color={theme.colors.primaryContrast} /> : null}
          <Text style={styles.actionText}>
            {active ? t('workspace.watch.close') : t('workspace.watch.open')}
          </Text>
        </TouchableOpacity>
        {note ? <Text style={styles.note}>{note}</Text> : null}
      </View>

      {/* ② SW2：给工作区助手下命令（走 agent 管线，带工具与确认）。 */}
      <Text style={styles.sectionTitle}>{t('workspace.watch.command')}</Text>
      <View style={styles.modeRow}>
        {WATCH_MODES.map(item => (
          <TouchableOpacity
            key={item}
            style={[styles.modeChip, mode === item && styles.modeChipActive]}
            onPress={() => setMode(item)}
            disabled={running}
            accessibilityRole="button"
            accessibilityState={{ selected: mode === item }}
          >
            <Text style={[styles.modeChipText, mode === item && styles.modeChipTextActive]}>
              {item === 'read' ? t('workspace.watch.modeRead') : t('workspace.watch.modeWrite')}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      <TextInput
        style={styles.input}
        value={command}
        onChangeText={setCommand}
        placeholder={t('workspace.watch.commandPlaceholder')}
        placeholderTextColor={theme.colors.textFaint}
        multiline
        editable={!running}
      />
      <View style={styles.commandRow}>
        <TouchableOpacity
          style={[styles.send, (!command.trim() || running) && styles.actionDisabled]}
          onPress={submitCommand}
          disabled={!command.trim() || running}
          accessibilityRole="button"
        >
          {running
            ? <ActivityIndicator size="small" color={theme.colors.primaryContrast} />
            : <Ionicons name="send" size={15} color={theme.colors.primaryContrast} />}
          <Text style={styles.actionText}>{running ? t('workspace.watch.running') : t('workspace.watch.send')}</Text>
        </TouchableOpacity>
        {running ? (
          <TouchableOpacity style={styles.stop} onPress={stopCommand} accessibilityRole="button">
            <Text style={styles.stopText}>{t('workspace.watch.stop')}</Text>
          </TouchableOpacity>
        ) : null}
      </View>
      {reply ? (
        <View style={styles.replyCard}>
          <Text style={styles.replyText} selectable>{reply}</Text>
        </View>
      ) : null}
      <Text style={styles.footnote}>{t('workspace.watch.writeHint')}</Text>

      {/* ② 工作区线程列表（scope='workspace'）：与聊天线程分开，不串上下文。
          FEAT-AC5 P0-A：点行展开完整对话（此前是裸 View，看着像卡片其实点不动）。 */}
      <Text style={styles.sectionTitle}>{t('workspace.watch.threads')}</Text>
      {threads.length === 0 ? (
        <Text style={styles.hint}>{t('workspace.watch.empty')}</Text>
      ) : (
        threads.map(thread => {
          const expanded = expandedId === thread.id;
          const name = String(thread.characterName || '').trim() || t('common.characterFallback');
          const entries = Array.isArray(thread.entries) ? thread.entries : [];
          return (
            <View key={thread.id}>
              <TouchableOpacity
                style={styles.threadRow}
                onPress={() => toggleThread(thread.id)}
                onLongPress={() => confirmDeleteThread(thread)}
                accessibilityRole="button"
                accessibilityState={{ expanded }}
                accessibilityLabel={`${name} · ${expanded
                  ? t('workspace.watch.collapseA11y')
                  : t('workspace.watch.expandA11y')}`}
                accessibilityHint={t('workspace.watch.deleteThread')}
              >
                <Ionicons
                  name={expanded ? 'chevron-down' : 'chevron-forward'}
                  size={16}
                  color={theme.colors.textMuted}
                />
                <View style={styles.threadInfo}>
                  <Text style={styles.threadName} numberOfLines={1}>{name}</Text>
                  <Text style={styles.threadPreview} numberOfLines={expanded ? 2 : 1}>
                    {screenThreadPreview(thread) || t('workspace.watch.emptyPreview')}
                  </Text>
                </View>
                <Text style={styles.threadCount}>{entries.length}</Text>
              </TouchableOpacity>
              {expanded ? (
                <View style={styles.entryBox}>
                  {entries.length === 0 ? (
                    <Text style={styles.hint}>{t('workspace.watch.noEntries')}</Text>
                  ) : (
                    entries.map(entry => (
                      <View key={entry.id} style={styles.entryRow}>
                        <Text style={styles.entryMeta}>
                          {`${t(threadEntryRoleKey(entry.role))}${formatThreadEntryTime(entry.at) ? ` · ${formatThreadEntryTime(entry.at)}` : ''}${entry.imageUri ? ` ${t('workspace.watch.entryImage')}` : ''}`}
                        </Text>
                        {/* selectable：用户要能复制出错信息去搜（任务书 §二 第 2 条）。 */}
                        <Text style={styles.entryText} selectable>{entry.text}</Text>
                      </View>
                    ))
                  )}
                  <TouchableOpacity
                    style={styles.deleteButton}
                    onPress={() => confirmDeleteThread(thread)}
                    accessibilityRole="button"
                    accessibilityLabel={t('workspace.watch.deleteThread.a11y', { name })}
                  >
                    <Ionicons name="trash-outline" size={14} color={theme.colors.danger} />
                    <Text style={styles.deleteText}>{t('workspace.watch.deleteThread')}</Text>
                  </TouchableOpacity>
                </View>
              ) : null}
            </View>
          );
        })
      )}

      {/* SW2 待办如实标注：会话管线尚未切到工作区 agent（当前仍走聊天角色管线）。 */}
      <Text style={styles.footnote}>{t('workspace.watch.sw2Note')}</Text>
    </ScrollView>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  container: { flex: 1 },
  body: { padding: 14, paddingBottom: 28 },
  title: { color: theme.colors.text, fontSize: fonts.scaled(16), fontWeight: '700' },
  hint: { color: theme.colors.textMuted, fontSize: fonts.scaled(12), marginTop: 6, lineHeight: fonts.scaled(17) },
  card: {
    marginTop: 12,
    padding: 12,
    borderRadius: tokens.radius.md,
    backgroundColor: theme.colors.surface,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
  },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  statusText: { flex: 1, color: theme.colors.text, fontSize: fonts.scaled(13), fontWeight: '600' },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: 10,
    paddingVertical: 9,
    borderRadius: tokens.radius.sm,
    backgroundColor: theme.colors.primary,
  },
  actionDisabled: { opacity: 0.5 },
  actionText: { color: theme.colors.primaryContrast, fontSize: fonts.scaled(13), fontWeight: '700' },
  note: { color: theme.colors.danger, fontSize: fonts.scaled(11.5), marginTop: 8, lineHeight: fonts.scaled(16) },
  sectionTitle: {
    color: theme.colors.text, fontSize: fonts.scaled(14), fontWeight: '700',
    marginTop: 18, marginBottom: 4,
  },
  threadRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingVertical: 9, borderBottomWidth: tokens.border.thin,
    borderBottomColor: theme.colors.surfaceBorder,
  },
  threadInfo: { flex: 1 },
  threadName: { color: theme.colors.text, fontSize: fonts.scaled(13), fontWeight: '600' },
  threadPreview: { color: theme.colors.textMuted, fontSize: fonts.scaled(11.5), marginTop: 2 },
  threadCount: { color: theme.colors.textFaint, fontSize: fonts.scaled(11) },
  // FEAT-AC5 P0-A：展开态（完整对话条目 + 删除入口）。
  // 左侧留出与行首 chevron 对齐的缩进，让展开内容视觉上从属于上面那一行。
  entryBox: {
    paddingLeft: 24, paddingBottom: 8,
    borderBottomWidth: tokens.border.thin, borderBottomColor: theme.colors.surfaceBorder,
  },
  entryRow: { marginTop: 6 },
  entryMeta: { color: theme.colors.textFaint, fontSize: fonts.scaled(10.5) },
  entryText: { color: theme.colors.text, fontSize: fonts.scaled(12), lineHeight: fonts.scaled(17), marginTop: 1 },
  deleteButton: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 10, alignSelf: 'flex-start' },
  deleteText: { color: theme.colors.danger, fontSize: fonts.scaled(11.5), fontWeight: '600' },
  // SW2：指令区（模式 chips + 输入框 + 发送/停止 + 回复卡）。
  modeRow: { flexDirection: 'row', gap: 8, marginTop: 6 },
  modeChip: {
    paddingHorizontal: 12, paddingVertical: 5, borderRadius: tokens.radius.pill,
    borderWidth: tokens.border.thin, borderColor: theme.colors.surfaceBorder,
  },
  modeChipActive: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  modeChipText: { color: theme.colors.textMuted, fontSize: fonts.scaled(11.5), fontWeight: '600' },
  modeChipTextActive: { color: theme.colors.primaryContrast },
  input: {
    marginTop: 8, minHeight: 56, paddingHorizontal: 10, paddingVertical: 8,
    borderRadius: tokens.radius.sm, borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder, backgroundColor: theme.colors.surface,
    color: theme.colors.text, fontSize: fonts.scaled(13),
  },
  commandRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 8 },
  send: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: tokens.radius.sm,
    backgroundColor: theme.colors.primary,
  },
  stop: { paddingHorizontal: 10, paddingVertical: 8 },
  stopText: { color: theme.colors.danger, fontSize: fonts.scaled(12.5), fontWeight: '600' },
  replyCard: {
    marginTop: 10, padding: 10, borderRadius: tokens.radius.md,
    backgroundColor: theme.colors.surface, borderWidth: tokens.border.thin,
    borderColor: theme.colors.primaryMutedAlpha(0.4),
  },
  replyText: { color: theme.colors.text, fontSize: fonts.scaled(12.5), lineHeight: fonts.scaled(18) },
  footnote: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), marginTop: 18, lineHeight: fonts.scaled(16) },
});
