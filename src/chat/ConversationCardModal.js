// 「从对话生成角色卡」：把用户在聊天页多选的消息交给模型，提炼成一张角色卡。
//
// 复用既有制卡管道（同 FORGE_SYSTEM / 同一份字段规则 / 同一个解析与自修复流程），
// 差别只在素材：从零制卡走问答，这里走真实对话。因此产出的卡字段结构完全一致，
// 用户可以在同一个编辑器里改，再走同一条导入路径进角色库。
//
// 两处刻意的约束：
// - 生成是用户点出来的，打开面板不自动发请求（要花钱）；
// - 保存前先过 hasCardContent：模型返回空壳时不落库，避免角色库里多出一张空卡。

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { EMPTY_REPLY_TEXT, getConfigFingerprint, isCanceledError, sendChatMessage } from '../network/api.js';
import { buildSystemPrompt } from '../character/cardParser.js';
import { getApiConfigs } from '../storage/apiConfigs.js';
import { useApp } from '../context/AppContext.js';
import CardForgeEditor from '../CardForgeEditor.js';
import {
  buildConversationCardPrompt,
  buildJsonRepairPrompt,
  draftToCharacterPatch,
  FIELD_ASSIST_SYSTEM,
  FIELD_LABELS,
  FORGE_SAMPLING_OVERRIDES,
  FORGE_SYSTEM,
  formatConversationTranscript,
  hasCardContent,
  parseCardPatch,
} from '../cardForge/forge.js';
import { Card, FieldHint, GhostButton, PrimaryButton, SecondaryButton, TextField } from '../ui/index.js';
import { useTheme } from '../theme/ThemeContext.js';
import { useTranslation } from '../i18n/I18nContext.js';

// 预览只展示这 6 个主字段：高级内容（世界书/正则/预设）由编辑器承载，
// 一屏罗列全部字段会让「这张卡像不像刚才那个角色」这个判断被淹没。
const PREVIEW_FIELDS = ['name', 'description', 'personality', 'scenario', 'firstMes', 'mesExample'];

export default function ConversationCardModal({
  visible,
  onClose,
  messages = [],
  characterName = '',
  userName = '',
}) {
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
  const { addCharacter, ensureCharacterSession } = useApp();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);

  const [hint, setHint] = useState('');
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const abortRef = useRef(null);

  const transcript = useMemo(
    () => formatConversationTranscript(messages, { userName, characterName }),
    [messages, userName, characterName]
  );

  useEffect(() => {
    if (visible) return undefined;
    // 关闭即中止在途请求，避免结果写回已关闭的面板
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    return undefined;
  }, [visible]);

  useEffect(() => () => {
    if (abortRef.current) abortRef.current.abort();
  }, []);

  const reset = useCallback(() => {
    setDraft(null);
    setError('');
    setHint('');
    setEditorOpen(false);
  }, []);

  const generate = useCallback(async () => {
    if (busy) return;
    if (transcript.kept === 0) {
      setError(t('chat.cardFromChat.error.noMessages'));
      return;
    }
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setError('');
    try {
      const { configs, activeId } = await getApiConfigs();
      const current = configs.find(item => item.id === activeId) || configs[0];
      const request = userPrompt => sendChatMessage([
        { role: 'system', content: FORGE_SYSTEM },
        { role: 'user', content: userPrompt },
      ], {
        stream: false,
        signal: controller.signal,
        expectedConfigId: String((current && current.id) || ''),
        expectedConfigFingerprint: current ? getConfigFingerprint(current) : '',
        overrides: FORGE_SAMPLING_OVERRIDES,
      });
      const prompt = buildConversationCardPrompt({
        transcript: transcript.text,
        characterName,
        userName,
        hint,
        dropped: transcript.dropped,
      });
      const raw = await request(prompt);
      let patch = parseCardPatch(raw);
      if (!patch) {
        // 解析失败多为 JSON 被截断或含非法转义：回传开头片段自修复重试 1 次（与制卡页一致）。
        patch = parseCardPatch(await request(buildJsonRepairPrompt(raw)));
      }
      if (!patch) throw new Error(t('chat.cardFromChat.error.parse'));
      if (!hasCardContent(patch)) throw new Error(t('chat.cardFromChat.error.empty'));
      setDraft(patch);
    } catch (caught) {
      if (isCanceledError && isCanceledError(caught)) return;
      if (caught && caught.name === 'AbortError') return;
      setError((caught && caught.message) || t('chat.cardFromChat.error.failed'));
    } finally {
      setBusy(false);
    }
  }, [busy, characterName, hint, t, transcript]);

  // 编辑器里的「AI 补写字段」：与制卡页同一条路径（同一份 FIELD_ASSIST_SYSTEM）。
  const assistPrompt = useCallback(async (prompt, signal) => {
    const { configs, activeId } = await getApiConfigs();
    const current = configs.find(item => item.id === activeId) || configs[0];
    const raw = await sendChatMessage([
      { role: 'system', content: FIELD_ASSIST_SYSTEM },
      { role: 'user', content: prompt },
    ], {
      stream: false,
      signal,
      expectedConfigId: String((current && current.id) || ''),
      expectedConfigFingerprint: current ? getConfigFingerprint(current) : '',
      overrides: FORGE_SAMPLING_OVERRIDES,
    });
    // 空回复会被 api 层替换成占位文案，直接写回会把「没有收到回复。」当成模型内容。
    const text = String(raw == null ? '' : raw).trim();
    if (!text || text === EMPTY_REPLY_TEXT) {
      throw new Error(t('forge.screen.error.emptyAiReply'));
    }
    return raw;
  }, [t]);

  const save = useCallback(async () => {
    if (saving || !draft) return;
    if (!hasCardContent(draft)) {
      setError(t('chat.cardFromChat.error.empty'));
      return;
    }
    setSaving(true);
    setError('');
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
      await ensureCharacterSession(created.id).catch(() => {});
      Alert.alert(
        t('chat.cardFromChat.saved.title'),
        t('chat.cardFromChat.saved.body', { name: created.name })
      );
      reset();
      onClose();
    } catch (caught) {
      setError((caught && caught.message) || t('chat.cardFromChat.error.saveFailed'));
    } finally {
      setSaving(false);
    }
  }, [addCharacter, draft, ensureCharacterSession, onClose, reset, saving, t]);

  const previewFields = useMemo(() => {
    if (!draft) return [];
    return PREVIEW_FIELDS
      .map(key => ({ key, label: FIELD_LABELS[key] || key, value: String(draft[key] || '').trim() }))
      .filter(item => item.value);
  }, [draft]);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>{t('chat.cardFromChat.title')}</Text>
          <TouchableOpacity onPress={onClose} hitSlop={8} accessibilityLabel={t('common.close')}>
            <Ionicons name="close" size={22} color={theme.colors.textMuted} />
          </TouchableOpacity>
        </View>

        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
          {!draft ? (
            <Card style={styles.card}>
              <View style={styles.summaryRow}>
                <Ionicons name="chatbubbles-outline" size={15} color={theme.colors.primaryMuted} />
                <Text style={styles.summaryText}>
                  {t('chat.cardFromChat.selected', { count: transcript.kept })}
                </Text>
              </View>
              {transcript.dropped > 0 ? (
                <Text style={styles.warnText}>
                  {t('chat.cardFromChat.dropped', { count: transcript.dropped })}
                </Text>
              ) : null}
              <TextField
                value={hint}
                onChangeText={setHint}
                placeholder={t('chat.cardFromChat.hintPlaceholder')}
                multiline
                style={styles.hintInput}
              />
              <PrimaryButton
                title={busy ? t('chat.cardFromChat.generating') : t('chat.cardFromChat.generate')}
                onPress={generate}
                loading={busy}
                disabled={busy}
                style={styles.primaryButton}
              />
              <FieldHint style={styles.hint}>{t('chat.cardFromChat.note')}</FieldHint>
            </Card>
          ) : (
            <>
              <Card style={styles.card}>
                <Text style={styles.cardTitle}>{t('chat.cardFromChat.preview.title')}</Text>
                {previewFields.map(item => (
                  <View key={item.key} style={styles.fieldRow}>
                    <Text style={styles.fieldLabel}>{item.label}</Text>
                    <Text style={styles.fieldValue}>{item.value}</Text>
                  </View>
                ))}
                {Array.isArray(draft.tags) && draft.tags.length > 0 ? (
                  <View style={styles.fieldRow}>
                    <Text style={styles.fieldLabel}>{t('chat.cardFromChat.preview.tags')}</Text>
                    <Text style={styles.fieldValue}>{draft.tags.join('、')}</Text>
                  </View>
                ) : null}
              </Card>
              <PrimaryButton
                title={saving ? t('chat.cardFromChat.saving') : t('chat.cardFromChat.save')}
                onPress={save}
                loading={saving}
                disabled={saving || busy}
                style={styles.primaryButton}
              />
              <View style={styles.secondaryRow}>
                <SecondaryButton
                  title={t('chat.cardFromChat.edit')}
                  onPress={() => setEditorOpen(true)}
                  disabled={saving}
                />
                <GhostButton
                  title={t('chat.cardFromChat.regenerate')}
                  onPress={generate}
                  disabled={saving || busy}
                />
              </View>
              <FieldHint style={styles.hint}>{t('chat.cardFromChat.saveHint')}</FieldHint>
            </>
          )}

          {busy && draft ? (
            <View style={styles.loadingRow}>
              <ActivityIndicator size="small" color={theme.colors.primary} />
              <Text style={styles.summaryText}>{t('chat.cardFromChat.generating')}</Text>
            </View>
          ) : null}

          {error ? <Text style={styles.errorText}>{error}</Text> : null}
        </ScrollView>

        <CardForgeEditor
          visible={editorOpen}
          draft={draft || {}}
          onClose={() => setEditorOpen(false)}
          onSave={nextDraft => {
            setEditorOpen(false);
            setDraft(nextDraft);
          }}
          onAssistPrompt={assistPrompt}
        />
      </View>
    </Modal>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 10,
  },
  title: { color: theme.colors.text, fontSize: fonts.scaled(17), fontWeight: '700' },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 20, paddingBottom: 32 },
  card: { marginBottom: tokens.metrics.cardGap },
  cardTitle: { color: theme.colors.text, fontSize: fonts.scaled(14), fontWeight: '700', marginBottom: 8 },
  summaryRow: { flexDirection: 'row', alignItems: 'center' },
  summaryText: { color: theme.colors.text, fontSize: fonts.scaled(13), marginLeft: 6, flexShrink: 1 },
  warnText: {
    color: theme.colors.star,
    fontSize: fonts.scaled(11),
    lineHeight: fonts.scaled(16),
    marginTop: 8,
  },
  hintInput: { marginTop: 12, minHeight: 64 },
  primaryButton: { marginTop: 12 },
  secondaryRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 10 },
  hint: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), lineHeight: fonts.scaled(16), marginTop: 10 },
  fieldRow: { marginTop: 8 },
  fieldLabel: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), fontWeight: '800' },
  fieldValue: {
    color: theme.colors.text,
    fontSize: fonts.scaled(12),
    lineHeight: fonts.scaled(18),
    marginTop: 2,
  },
  loadingRow: { flexDirection: 'row', alignItems: 'center', marginTop: 10 },
  errorText: { color: theme.colors.danger, fontSize: fonts.scaled(12), marginTop: 10, lineHeight: fonts.scaled(18) },
});
