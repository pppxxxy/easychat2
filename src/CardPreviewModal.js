import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { isCanceledError } from './api';
import AssistantMessageBody from './AssistantMessageBody';
import {
  buildPreviewDisplayTurns,
  buildPreviewOpeningTurns,
  buildPreviewSections,
  capPreviewHistory,
  previewAdvancedCounts,
} from './cardForge/preview';
import { maskSecrets } from './secrets';
import { PrimaryButton, TextField } from './ui';
import { useTheme } from './theme/ThemeContext';

// 制卡预览：只读展示当前草稿，并允许用真实模型多轮模拟对话。
// 对话仅存在于本组件的内存状态里，关闭即重置，不写入角色库或聊天记录。
export default function CardPreviewModal({ visible, draft, onClose, onSendTurn }) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);

  const [turns, setTurns] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const wasVisibleRef = useRef(false);
  const abortRef = useRef(null);
  const scrollRef = useRef(null);
  const turnsRef = useRef(turns);
  // 只有发消息后才自动滚到底部；打开时保持顶部（先看卡片内容）。
  const scrollPendingRef = useRef(false);
  turnsRef.current = turns;

  // 打开那一刻用最新草稿重置对话；关闭时中止还没回来的回复。
  useEffect(() => {
    const justOpened = visible && !wasVisibleRef.current;
    wasVisibleRef.current = visible;
    if (justOpened) {
      setTurns(buildPreviewOpeningTurns(draft));
      setInput('');
      setBusy(false);
      scrollPendingRef.current = false;
      return;
    }
    if (!visible && abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
      setBusy(false);
    }
  }, [visible, draft]);

  useEffect(() => () => {
    if (abortRef.current) abortRef.current.abort();
  }, []);

  useEffect(() => {
    if (scrollPendingRef.current && scrollRef.current) {
      scrollRef.current.scrollToEnd({ animated: true });
      scrollPendingRef.current = false;
    }
  }, [turns]);

  const sections = useMemo(() => buildPreviewSections(draft), [draft]);
  const counts = useMemo(() => previewAdvancedCounts(draft), [draft]);
  // 展示正则与聊天页同一口径：预览里就能看到正则应用后的效果。
  const displayTurns = useMemo(
    () => buildPreviewDisplayTurns(turns, draft),
    [turns, draft]
  );
  const name = String((draft && draft.name) || '').trim() || '未命名';
  const tags = Array.isArray(draft && draft.tags) ? draft.tags : [];

  const clear = () => {
    if (busy) return;
    scrollPendingRef.current = false;
    setTurns(buildPreviewOpeningTurns(draft));
  };

  const send = async () => {
    const text = String(input || '').trim();
    if (!text || busy) return;
    if (typeof onSendTurn !== 'function') {
      Alert.alert('功能不可用', '当前没有可用的模型配置。');
      return;
    }
    const history = capPreviewHistory(turnsRef.current);
    const controller = new AbortController();
    abortRef.current = controller;
    scrollPendingRef.current = true;
    setTurns(current => [...current, { id: `preview-u-${Date.now()}`, role: 'user', text }]);
    setInput('');
    setBusy(true);
    try {
      const reply = await onSendTurn(history, text, controller.signal);
      const cleaned = String(reply || '').trim();
      if (!cleaned) throw new Error('模型没有返回内容。');
      scrollPendingRef.current = true;
      setTurns(current => [...current, { id: `preview-a-${Date.now()}`, role: 'assistant', text: cleaned }]);
    } catch (error) {
      if (!isCanceledError(error)) {
        Alert.alert('模拟对话失败', maskSecrets((error && error.message) || '请稍后重试。'));
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setBusy(false);
      }
    }
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.header}>
          <Text style={styles.title}>预览</Text>
          <TouchableOpacity onPress={onClose} hitSlop={8} accessibilityLabel="关闭预览">
            <Ionicons name="close" size={22} color={theme.colors.textMuted} />
          </TouchableOpacity>
        </View>

        <ScrollView
          ref={scrollRef}
          style={styles.scroll}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.card}>
            <View style={styles.cardHead}>
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>{name.slice(0, 1)}</Text>
              </View>
              <View style={styles.cardHeadText}>
                <Text style={styles.cardName} numberOfLines={1}>{name}</Text>
                {tags.length > 0 ? (
                  <Text style={styles.cardTags} numberOfLines={2}>{tags.join('、')}</Text>
                ) : null}
                {counts.length > 0 ? (
                  <Text style={styles.cardCounts} numberOfLines={1}>{counts.join(' · ')}</Text>
                ) : null}
              </View>
            </View>
            {sections.map(section => (
              <View key={section.label} style={styles.section}>
                <Text style={styles.sectionLabel}>{section.label}</Text>
                <Text style={styles.sectionText}>{section.text}</Text>
              </View>
            ))}
            {sections.length === 0 ? (
              <Text style={styles.emptyHint}>这张卡还没有可展示的内容，可以先在卡片里补充。</Text>
            ) : null}
          </View>

          <View style={styles.chatHeader}>
            <Text style={styles.chatTitle}>模拟对话</Text>
            <TouchableOpacity
              onPress={clear}
              hitSlop={8}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel="清空模拟对话"
            >
              <Text style={[styles.clearText, busy && styles.disabled]}>{'清空'}</Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.chatHint}>用当前模型按这张卡的设定真实扮演，仅用于测试，不会写入角色库或聊天记录。</Text>

          {turns.length === 0 ? (
            <Text style={styles.emptyHint}>这张卡还没有开场白，直接发一句话开始模拟。</Text>
          ) : displayTurns.map(turn => {
            const isUser = turn.role === 'user';
            return (
              <View key={turn.id} style={[styles.bubbleRow, isUser && styles.bubbleRowUser]}>
                <View style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAi]}>
                  {isUser ? (
                    <Text style={[styles.bubbleText, styles.bubbleTextUser]}>{turn.display}</Text>
                  ) : (
                    <AssistantMessageBody text={turn.display} fullWidth />
                  )}
                </View>
              </View>
            );
          })}

          {busy ? (
            <View style={styles.busyRow}>
              <ActivityIndicator size="small" color={theme.colors.primary} />
              <Text style={styles.busyText}>角色正在输入…</Text>
            </View>
          ) : null}
        </ScrollView>

        <View style={styles.footer}>
          <TextField
            style={styles.input}
            value={input}
            onChangeText={setInput}
            placeholder="以用户身份发一句话，测试这张卡"
            onSubmitEditing={send}
            returnKeyType="send"
            editable={!busy}
          />
          <PrimaryButton
            title="发送"
            small
            onPress={send}
            disabled={busy || !input.trim()}
            style={styles.sendButton}
          />
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: tokens.border.thin,
    borderBottomColor: theme.colors.divider,
  },
  title: { color: theme.colors.text, fontSize: fonts.scaled(17), fontWeight: '800' },
  scroll: { flex: 1 },
  content: { padding: 16, paddingBottom: 20 },
  card: {
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: tokens.radius.md,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    padding: tokens.spacing.md,
    marginBottom: tokens.spacing.lg,
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', marginBottom: tokens.spacing.sm },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.primary,
    marginRight: tokens.spacing.md,
  },
  avatarText: { color: theme.colors.primaryContrast, fontSize: fonts.scaled(18), fontWeight: '800' },
  cardHeadText: { flex: 1 },
  cardName: { color: theme.colors.text, fontSize: fonts.scaled(16), fontWeight: '800' },
  cardTags: { color: theme.colors.primarySoft, fontSize: fonts.scaled(12), marginTop: 2 },
  cardCounts: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), marginTop: 2 },
  section: { marginTop: tokens.spacing.sm },
  sectionLabel: { color: theme.colors.textMuted, fontSize: fonts.scaled(12), fontWeight: '700', marginBottom: 2 },
  sectionText: { color: theme.colors.text, fontSize: fonts.scaled(13), lineHeight: fonts.scaled(19) },
  chatHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  chatTitle: { color: theme.colors.text, fontSize: fonts.scaled(15), fontWeight: '800' },
  clearText: { color: theme.colors.primarySoft, fontSize: fonts.scaled(12), fontWeight: '700' },
  disabled: { opacity: tokens.opacity.disabled },
  chatHint: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(11),
    lineHeight: fonts.scaled(16),
    marginTop: 2,
    marginBottom: tokens.spacing.sm,
  },
  emptyHint: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(12),
    lineHeight: fonts.scaled(18),
    marginBottom: tokens.spacing.sm,
  },
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
  bubbleText: { color: theme.colors.text, fontSize: fonts.scaled(14), lineHeight: fonts.scaled(20) },
  bubbleTextUser: { color: theme.colors.primaryContrast },
  busyRow: { flexDirection: 'row', alignItems: 'center', paddingBottom: 6 },
  busyText: { color: theme.colors.textFaint, fontSize: fonts.scaled(12), marginLeft: 6 },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 14,
    borderTopWidth: tokens.border.thin,
    borderTopColor: theme.colors.divider,
  },
  input: { flex: 1, marginRight: 8 },
  sendButton: { minWidth: 72 },
});
