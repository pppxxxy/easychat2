import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { isCanceledError, sendChatMessage } from './api';
import { buildSystemPrompt } from './cardParser';
import { useApp } from './context/AppContext';
import CardForgeEditor from './CardForgeEditor';
import {
  appendTranscript,
  buildEditPrompt,
  buildGeneratePrompt,
  createForgeState,
  currentQuestion,
  draftToCharacterPatch,
  hasCardContent,
  mergeDraft,
  parseCardPatch,
  recordAnswer,
  summarizeAnswers,
} from './cardForge/forge';
import { clearCardForge, getCardForgeStatus, saveCardForge } from './storage';
import { Chip, PrimaryButton, TextField } from './ui';
import { useTheme } from './theme/ThemeContext';

const FORGE_SYSTEM = '你是中文角色卡撰写与编辑助手，严格遵守输出格式要求，只输出要求的 JSON。';

export default function CardForgeScreen({ active = true, refreshKey = 0 }) {
  const { theme, fonts, tokens } = useTheme();
  const { addCharacter, ensureCharacterSession } = useApp();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);

  const [state, setState] = useState(null);
  const [input, setInput] = useState('');
  const [freeText, setFreeText] = useState('');
  const [freeQuestionId, setFreeQuestionId] = useState('');
  const [busy, setBusy] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const loadErrorRef = useRef(false);
  const stateRef = useRef(null);
  const scrollRef = useRef(null);
  const mountedRef = useRef(true);
  const activeRef = useRef(active);
  const requestControllerRef = useRef(null);
  const requestTokenRef = useRef(0);
  activeRef.current = active;
  stateRef.current = state;

  const applyState = useCallback(next => {
    stateRef.current = next;
    setState(next);
  }, []);

  const update = useCallback(next => {
    if (loadErrorRef.current) return Promise.resolve(false);
    applyState(next);
    return saveCardForge(next).catch(error => {
      if (mountedRef.current) {
        Alert.alert('草稿保存失败', '当前内容已保留在界面，请检查存储空间或权限。');
      }
      return false;
    });
  }, [applyState]);

  const isRequestCurrent = useCallback((token, controller) => (
    mountedRef.current
    && activeRef.current
    && requestTokenRef.current === token
    && requestControllerRef.current === controller
    && !controller.signal.aborted
  ), []);

  useEffect(() => {
    if (active) return;
    requestTokenRef.current += 1;
    const controller = requestControllerRef.current;
    requestControllerRef.current = null;
    controller?.abort();
    if (mountedRef.current) setBusy(false);
  }, [active]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestTokenRef.current += 1;
      const controller = requestControllerRef.current;
      requestControllerRef.current = null;
      controller?.abort();
    };
  }, []);

  // 每次切到「制卡」都从存储重读：角色页的「导入到制卡」会改写存储草稿，
  // 而扩展页的各个模块是一直挂载的，不回读就会看到旧内容。
  // refreshKey 由角色页的导入导航带入（params.ts）：即使用户已经停在「制卡」
  // 分段（active 仍为 true），也能触发重读，避免旧草稿覆盖刚导入的内容。
  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
     getCardForgeStatus()
       .then(result => {
         if (cancelled) return;
         if (result.status === 'corrupt') {
           loadErrorRef.current = true;
           applyState(createForgeState());
           Alert.alert('制卡草稿读取失败', '原始草稿已保留，请使用“重新开始”清理后再编辑。');
           return;
         }
         loadErrorRef.current = false;
         applyState(result.state || createForgeState());
       })
       .catch(() => {
         if (cancelled) return;
         loadErrorRef.current = true;
         applyState(createForgeState());
         Alert.alert('制卡草稿读取失败', '请稍后重试。');
       });

    return () => {
      cancelled = true;
    };
  }, [active, refreshKey, applyState]);

  const askModel = useCallback(async (prompt, signal) => {
    const raw = await sendChatMessage([
      { role: 'system', content: FORGE_SYSTEM },
      { role: 'user', content: prompt },
    ], { stream: false, signal });
    return parseCardPatch(raw);
  }, []);

  const submitAnswer = useCallback((question, value) => {
    const text = String(value || '').trim();
    if (!text || busy || !question || !activeRef.current || !mountedRef.current) return;
    if (loadErrorRef.current) {
      Alert.alert('草稿需要重置', '请先重新开始，清理损坏草稿后再编辑。');
      return;
    }
    setFreeQuestionId('');
    setFreeText('');
    update(recordAnswer(stateRef.current, question.id, text));
  }, [busy, update]);

  const onPickOption = useCallback((question, option) => {
    if (busy) return;
    if (option.free) {
      setFreeQuestionId(question.id);
      setFreeText('');
      return;
    }
    submitAnswer(question, option.label);
  }, [busy, submitAnswer]);

  const onGenerate = useCallback(() => {
    if (busy || !activeRef.current || !mountedRef.current) return;
    if (loadErrorRef.current) {
      Alert.alert('草稿需要重置', '请先重新开始，清理损坏草稿后再生成。');
      return;
    }
    const run = async () => {
      if (!activeRef.current || !mountedRef.current) return;
      const token = ++requestTokenRef.current;
      const controller = new AbortController();
      requestControllerRef.current = controller;
      setBusy(true);
      const base = stateRef.current;
      try {
        const patch = await askModel(buildGeneratePrompt(base), controller.signal);
        if (!isRequestCurrent(token, controller)) return;
        if (!patch) {
          await update(appendTranscript(stateRef.current, {
            role: 'note',
            text: '生成失败：模型没有返回可用的 JSON，再试一次。',
          }));
          return;
        }
        const latest = stateRef.current || base;
        const { draft, changed } = mergeDraft(latest.draft, patch);
        let next = { ...latest, draft, updatedAt: Date.now() };
        next = appendTranscript(next, {
          role: 'ai',
          text: changed.length > 0
            ? `已生成/更新：${changed.join('、')}。点「卡片」查看，或继续说修改要求。`
            : '生成结果与当前内容一致。',
        });
        const saved = await update(next);
        if (saved && isRequestCurrent(token, controller)) setEditorOpen(true);
      } catch (error) {
        if (isRequestCurrent(token, controller) && !isCanceledError(error)) {
          Alert.alert('生成失败', (error && error.message) || '请稍后重试。');
        }
      } finally {
        if (isRequestCurrent(token, controller)) {
          requestControllerRef.current = null;
          setBusy(false);
        }
      }
    };
    if (hasCardContent(stateRef.current && stateRef.current.draft)) {
      Alert.alert('生成卡片', '会按问答与你的要求重写当前草稿，继续吗？', [
        { text: '取消', style: 'cancel' },
        { text: '生成', onPress: () => { run(); } },
      ]);
      return;
    }
    run();
  }, [askModel, busy, isRequestCurrent, update]);

  const onSend = useCallback(async () => {
    const text = String(input || '').trim();
    if (!text || busy || !activeRef.current || !mountedRef.current) return;
    if (loadErrorRef.current) {
      Alert.alert('草稿需要重置', '请先重新开始，清理损坏草稿后再发送。');
      return;
    }
    const token = ++requestTokenRef.current;
    const controller = new AbortController();
    requestControllerRef.current = controller;
    setInput('');
    setBusy(true);
    const base = stateRef.current;
    try {
      const transcriptSaved = await update(appendTranscript(base, {
        id: `u-${Date.now()}`,
        role: 'user',
        text,
      }));
      if (!transcriptSaved || !isRequestCurrent(token, controller)) return;
      const latest = stateRef.current || base;
      const patch = await askModel(buildEditPrompt({
        draft: latest.draft,
        request: text,
        answers: summarizeAnswers(latest),
      }), controller.signal);
      if (!isRequestCurrent(token, controller)) return;
      if (!patch) {
        await update(appendTranscript(stateRef.current, {
          role: 'note',
          text: '这次没解析出可用的卡片内容，换个说法再试（例如「把性格改得更冷淡」）。',
        }));
        return;
      }
      const current = stateRef.current;
      const { draft, changed } = mergeDraft(current.draft, patch);
      let next = { ...current, draft, updatedAt: Date.now() };
      next = appendTranscript(next, {
        role: 'ai',
        text: changed.length > 0
          ? `已更新：${changed.join('、')}。`
          : '内容没有变化，可以说得更具体些。',
      });
      await update(next);
    } catch (error) {
      if (isRequestCurrent(token, controller) && !isCanceledError(error)) {
        Alert.alert('制卡失败', (error && error.message) || '请稍后重试。');
      }
    } finally {
      if (isRequestCurrent(token, controller)) {
        requestControllerRef.current = null;
        setBusy(false);
      }
    }
  }, [askModel, busy, input, isRequestCurrent, update]);

  const onSaveDraft = useCallback(nextDraft => {
    if (!mountedRef.current || !activeRef.current) return;
    setEditorOpen(false);
    update({ ...stateRef.current, draft: nextDraft, updatedAt: Date.now() });
  }, [update]);

  const onImport = useCallback(async () => {
    if (busy) return;
    const draft = stateRef.current && stateRef.current.draft;
    if (!hasCardContent(draft)) {
      Alert.alert('卡片还是空的', '先回答问题后点「生成」，或直接输入你的要求。');
      return;
    }
    try {
      const composedPrompt = buildSystemPrompt({
        description: draft.description,
        personality: draft.personality,
        scenario: draft.scenario,
        systemPrompt: draft.systemPrompt || '',
        postHistoryInstructions: draft.postHistoryInstructions,
      });
      const patch = draftToCharacterPatch(draft, { composedPrompt });
       const created = await addCharacter(patch);
       if (!mountedRef.current || !activeRef.current) return;
       await ensureCharacterSession(created.id).catch(() => {});
       if (!mountedRef.current || !activeRef.current) return;
       update(appendTranscript(stateRef.current, {

        role: 'note',
        text: `已导入角色库：${created.name}。可以去「角色」页查看，或继续修改后再次导入。`,
      }));
      Alert.alert('已导入', `角色「${created.name}」已加入角色库，并已为它准备好新会话。`);
    } catch (error) {
      Alert.alert('导入失败', (error && error.message) || '请检查存储空间或权限。');
    }
  }, [addCharacter, busy, ensureCharacterSession, update]);

  const onReset = useCallback(() => {
    if (busy) return;
    Alert.alert('重新开始', '会清空当前问答与草稿，继续吗？', [
      { text: '取消', style: 'cancel' },
      {
        text: '清空',
        style: 'destructive',
         onPress: async () => {
           if (!mountedRef.current || !activeRef.current) return;
           try {
             await clearCardForge();
             if (!mountedRef.current || !activeRef.current) return;
             loadErrorRef.current = false;
             await update(createForgeState());
           } catch (error) {
             if (mountedRef.current) {
               Alert.alert('清空失败', '请检查存储空间或权限。');
             }
           }
         },

      },
    ]);
  }, [busy, update]);

  if (!state) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={theme.colors.primary} />
      </View>
    );
  }

  const question = currentQuestion(state);
  const draft = state.draft || {};
  const draftName = String(draft.name || '').trim();
  const tagLine = Array.isArray(draft.tags) && draft.tags.length > 0 ? ` · ${draft.tags.join('、')}` : '';

  const renderOptions = currentQ => (
    <View style={styles.options}>
      {currentQ.options.map(option => (
        <Chip
          key={option.id}
          label={option.label}
          disabled={busy}
          onPress={() => onPickOption(currentQ, option)}
        />
      ))}
      {freeQuestionId === currentQ.id ? (
        <View style={styles.freeRow}>
          <TextField
            style={styles.freeInput}
            value={freeText}
            onChangeText={setFreeText}
            placeholder={currentQ.freeHint || '输入你的设定'}
            autoFocus
          />
          <PrimaryButton
            title="确定"
            small
            onPress={() => submitAnswer(currentQ, freeText)}
            disabled={busy || !freeText.trim()}
          />
        </View>
      ) : null}
    </View>
  );

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.header}>
        <Text style={styles.title}>制卡</Text>
        <View style={styles.headerActions}>
          <TouchableOpacity
            style={styles.action}
            onPress={() => setEditorOpen(true)}
            activeOpacity={0.8}
            accessibilityLabel="查看当前角色卡"
          >
            <Ionicons name="id-card-outline" size={15} color={theme.colors.primarySoft} />
            <Text style={styles.actionText}>卡片</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.action, busy && styles.actionDisabled]}
            onPress={onGenerate}
            disabled={busy}
            activeOpacity={0.8}
            accessibilityLabel="根据问答生成卡片"
          >
            <Ionicons name="sparkles-outline" size={15} color={theme.colors.primarySoft} />
            <Text style={styles.actionText}>生成</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.action, busy && styles.actionDisabled]}
            onPress={onReset}
            disabled={busy}
            activeOpacity={0.8}
            accessibilityLabel="清空重新开始"
          >
            <Ionicons name="refresh-outline" size={15} color={theme.colors.textFaint} />
            <Text style={styles.actionText}>重来</Text>
          </TouchableOpacity>
        </View>
      </View>

      <Text style={styles.draftLine} numberOfLines={1}>
        {hasCardContent(draft)
          ? `草稿：${draftName || '未命名'}${tagLine}`
          : '还没有内容：先回答问题，或直接在下面说要求'}
      </Text>

      <ScrollView
        ref={scrollRef}
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={() => {
          if (scrollRef.current) scrollRef.current.scrollToEnd({ animated: true });
        }}
      >
        {state.transcript.map(entry => {
          const isUser = entry.role === 'user';
          const isNote = entry.role === 'note';
          const isCurrentQuestion = !!question && entry.questionId === question.id;
          return (
            <View key={entry.id} style={[styles.bubbleRow, isUser && styles.bubbleRowUser]}>
              <View
                style={[
                  styles.bubble,
                  isUser ? styles.bubbleUser : (isNote ? styles.bubbleNote : styles.bubbleAi),
                ]}
              >
                <Text style={[styles.bubbleText, isUser && styles.bubbleTextUser]}>{entry.text}</Text>
              </View>
              {isCurrentQuestion ? renderOptions(question) : null}
            </View>
          );
        })}
      </ScrollView>

      {busy ? (
        <View style={styles.busyRow}>
          <ActivityIndicator size="small" color={theme.colors.primary} />
          <Text style={styles.busyText}>正在写卡…</Text>
        </View>
      ) : null}

      <View style={styles.footer}>
        <TextField
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder="直接说需求或修改意见，例如：想让她更冷淡一点"
          onSubmitEditing={onSend}
          returnKeyType="send"
          editable={!busy}
        />
        <PrimaryButton
          title="发送"
          small
          onPress={onSend}
          disabled={busy || !input.trim()}
          style={styles.sendButton}
        />
      </View>

      <View style={styles.importRow}>
        <PrimaryButton
          title="导入到角色库"
          icon="download-outline"
          onPress={onImport}
          disabled={busy}
        />
      </View>

      <CardForgeEditor
        visible={editorOpen}
        draft={draft}
        onClose={() => setEditorOpen(false)}
        onSave={onSaveDraft}
      />
    </KeyboardAvoidingView>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 4,
    paddingBottom: 6,
  },
  title: { color: theme.colors.text, fontSize: fonts.scaled(20), fontWeight: '800' },
  headerActions: { flexDirection: 'row', alignItems: 'center' },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginLeft: 6,
    borderRadius: tokens.radius.pill,
    backgroundColor: theme.colors.surface,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
  },
  actionDisabled: { opacity: tokens.opacity.disabled },
  actionText: { color: theme.colors.textMuted, fontSize: fonts.scaled(12), fontWeight: '700', marginLeft: 4 },
  draftLine: {
    paddingHorizontal: 20,
    paddingBottom: 8,
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(12),
  },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 16, paddingBottom: 12 },
  bubbleRow: { alignItems: 'flex-start', marginBottom: 10 },
  bubbleRowUser: { alignItems: 'flex-end' },
  bubble: {
    maxWidth: '92%',
    borderRadius: tokens.radius.lg,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
  },
  bubbleAi: { backgroundColor: theme.colors.surface },
  bubbleUser: { backgroundColor: theme.colors.primary },
  bubbleNote: { backgroundColor: theme.colors.surfaceAlt, borderStyle: 'dashed' },
  bubbleText: { color: theme.colors.text, fontSize: fonts.scaled(14), lineHeight: fonts.scaled(20) },
  bubbleTextUser: { color: theme.colors.primaryContrast },
  options: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 8, maxWidth: '96%' },
  freeRow: { flexDirection: 'row', alignItems: 'center', width: '100%', marginTop: 2 },
  freeInput: { flex: 1, marginRight: 8 },
  busyRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingBottom: 6 },
  busyText: { color: theme.colors.textFaint, fontSize: fonts.scaled(12), marginLeft: 6 },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  input: { flex: 1, marginRight: 8 },
  sendButton: { minWidth: 72 },
  importRow: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 14 },
});
