// 记忆溯源面板：把向量记忆（对话片段）摊开，做两件既有索引数据支持、但一直没有界面的事。
//
// 1) 溯源：每条记忆都记着它是从哪个会话的哪条消息切出来的（索引里的 sessionId +
//    messageId），点开能看到「证据链」——源消息 + 前后文。合并出来的记忆则展示
//    合并前的快照。
// 2) 冲突：向量相似度挑出同一件事的候选对，交给模型判是否语义矛盾；用户逐对选择
//    保留哪条，或让 AI 合并成一条更新后的记忆。
//
// 这里只做「读出来给人看 + 按用户选择改索引」，不自动改记忆：任何一条记忆的消失
// 或改写都必须是用户点出来的。

import React, { useCallback, useEffect, useMemo, useState } from 'react';
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

import { sendChatMessage } from '../network/api.js';
import { getMessagesBySession } from '../storage/sessions.js';
import { getVectorIndex, getVectorMemoryConfig, updateVectorIndex } from '../storage/vector.js';
import {
  getMemoryConflicts,
  removeMemoryConflictsForMemories,
  resolveMemoryConflict,
  upsertMemoryConflicts,
} from '../storage/memoryConflicts.js';
import { embedTexts, vectorSignature } from '../vectorMemory/index.js';
import { Card, EmptyState, GhostButton, PrimaryButton } from '../ui/index.js';
import { useTheme } from '../theme/ThemeContext.js';
import { useTranslation } from '../i18n/I18nContext.js';

import {
  buildEvidenceChain,
  groupMemoriesBySession,
  memoryKey,
  memorySources,
} from './provenance.js';
import {
  buildConflictPrompt,
  buildMergePrompt,
  candidatePairs,
  conflictIndex,
  judgedPairKeys,
  parseConflictResponse,
  parseMergeResponse,
  pendingConflicts,
  RESOLUTION_IGNORED,
} from './conflict.js';

function formatTime(at) {
  const value = Number(at) || 0;
  if (!value) return '';
  const date = new Date(value);
  const pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export default function MemoryProvenanceModal({
  visible,
  onClose,
  characterId = '',
  characterName = '',
  sessions = [],
}) {
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);

  const [memories, setMemories] = useState([]);
  const [conflicts, setConflicts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [scanning, setScanning] = useState(false);
  const [scanNote, setScanNote] = useState(null);
  const [busyKey, setBusyKey] = useState('');
  const [evidence, setEvidence] = useState(null);

  const sessionNameOf = useCallback(sessionId => {
    const id = String(sessionId || '');
    if (!id) return t('memory.provenance.sessionUnknown');
    const session = (Array.isArray(sessions) ? sessions : []).find(item => item && item.id === id);
    if (!session) return t('memory.provenance.sessionMissing');
    if (session.type === 'group') {
      return String(session.name || '').trim() || t('common.groupChat');
    }
    return String(characterName || '').trim() || t('memory.unnamedCharacter');
  }, [characterName, sessions, t]);

  const reload = useCallback(async () => {
    if (!characterId) {
      setMemories([]);
      setConflicts([]);
      return;
    }
    const [index, records] = await Promise.all([
      getVectorIndex(characterId).catch(() => []),
      getMemoryConflicts(characterId).catch(() => []),
    ]);
    setMemories(Array.isArray(index) ? index : []);
    setConflicts(Array.isArray(records) ? records : []);
  }, [characterId]);

  useEffect(() => {
    if (!visible) return undefined;
    let alive = true;
    setLoading(true);
    setError('');
    setScanNote(null);
    setEvidence(null);
    reload()
      .catch(caught => {
        if (alive) setError((caught && caught.message) || t('memory.provenance.loadFail'));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => { alive = false; };
  }, [visible, reload, t]);

  const groups = useMemo(
    () => groupMemoriesBySession(memories, { sessionName: sessionNameOf }),
    [memories, sessionNameOf]
  );
  const badges = useMemo(() => conflictIndex(conflicts), [conflicts]);
  const pending = useMemo(() => pendingConflicts(conflicts), [conflicts]);
  const memoryByKey = useMemo(
    () => new Map(memories.map(item => [memoryKey(item), item])),
    [memories]
  );

  // 删记忆：只动索引，不碰原始消息（消息还在会话里，删掉的只是「被记住」这件事）。
  const dropMemories = useCallback(async keys => {
    const targets = new Set((Array.isArray(keys) ? keys : [keys]).map(String).filter(Boolean));
    if (targets.size === 0) return;
    await updateVectorIndex(characterId, current => (
      current.filter(item => !targets.has(memoryKey(item)))
    ));
    await removeMemoryConflictsForMemories(characterId, [...targets]);
  }, [characterId]);

  // 保留其中一条：删掉另一条即可。不额外记「保留」决议——被保留的那条还在，
  // 被删的那条消失后这对组合不可能再出现，留一条指向已删记忆的决议只是垃圾。
  const onKeep = useCallback(async (record, side) => {
    if (!record || busyKey) return;
    const dropKey = side === 'a' ? record.bKey : record.aKey;
    setBusyKey(record.key);
    setError('');
    try {
      await dropMemories([dropKey]);
      await reload();
      setScanNote({ kind: 'kept' });
    } catch (caught) {
      setError((caught && caught.message) || t('memory.provenance.actionFail'));
    } finally {
      setBusyKey('');
    }
  }, [busyKey, dropMemories, reload, t]);

  const onIgnore = useCallback(async record => {
    if (!record || busyKey) return;
    setBusyKey(record.key);
    try {
      await resolveMemoryConflict(characterId, record.key, RESOLUTION_IGNORED);
      await reload();
    } catch (caught) {
      setError((caught && caught.message) || t('memory.provenance.actionFail'));
    } finally {
      setBusyKey('');
    }
  }, [busyKey, characterId, reload, t]);

  // AI 合并：两条变一条。合并后的记忆要能被正常召回，所以必须先拿到向量；
  // 拿不到（没配向量服务 / 网络失败）就整件事中止——绝不写一条没有向量的记忆，
  // 那只会变成一条永远召不回的僵尸条目。
  const onMerge = useCallback(async record => {
    if (!record || busyKey) return;
    const left = memoryByKey.get(record.aKey);
    const right = memoryByKey.get(record.bKey);
    if (!left || !right) {
      setError(t('memory.provenance.merge.missing'));
      return;
    }
    setBusyKey(record.key);
    setError('');
    try {
      const mergedText = parseMergeResponse(
        await sendChatMessage(buildMergePrompt(left, right))
      );
      if (!mergedText) throw new Error(t('memory.provenance.merge.empty'));
      const config = await getVectorMemoryConfig();
      const [vector] = await embedTexts({ config, texts: [mergedText] });
      if (!Array.isArray(vector) || vector.length === 0) {
        throw new Error(t('memory.provenance.merge.noVector'));
      }
      const newer = (Number(right.at) || 0) >= (Number(left.at) || 0) ? right : left;
      const mergedItem = {
        id: `merged-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        messageId: '',
        sessionId: String(newer.sessionId || ''),
        role: String(newer.role || ''),
        at: Date.now(),
        text: mergedText,
        vector,
        signature: vectorSignature(config),
        origin: 'merged',
        mergedFrom: [left, right].map(item => ({
          id: String(item.id || ''),
          sessionId: String(item.sessionId || ''),
          messageId: String(item.messageId || ''),
          text: String(item.text || ''),
          at: Number(item.at) || 0,
        })),
      };
      const targets = new Set([record.aKey, record.bKey]);
      await updateVectorIndex(characterId, current => [
        ...current.filter(item => !targets.has(memoryKey(item))),
        mergedItem,
      ]);
      await removeMemoryConflictsForMemories(characterId, [...targets]);
      await reload();
      setScanNote({ kind: 'merged' });
    } catch (caught) {
      setError((caught && caught.message) || t('memory.provenance.merge.fail'));
    } finally {
      setBusyKey('');
    }
  }, [busyKey, characterId, memoryByKey, reload, t]);

  const onScan = useCallback(async () => {
    if (scanning || !characterId) return;
    setError('');
    setScanNote(null);
    const pairs = candidatePairs(memories, { excludeKeys: judgedPairKeys(conflicts) });
    if (pairs.length === 0) {
      setScanNote({ kind: 'none' });
      return;
    }
    setScanning(true);
    try {
      const verdicts = parseConflictResponse(
        await sendChatMessage(buildConflictPrompt(pairs)),
        pairs
      );
      const byKey = new Map(pairs.map(pair => [pair.key, pair]));
      const records = verdicts
        .filter(verdict => verdict.parsed && byKey.has(verdict.key))
        .map(verdict => {
          const pair = byKey.get(verdict.key);
          return {
            key: verdict.key,
            aKey: memoryKey(pair.left),
            bKey: memoryKey(pair.right),
            aText: String(pair.left.text || ''),
            bText: String(pair.right.text || ''),
            score: pair.score,
            conflict: verdict.conflict === true,
            reason: verdict.reason,
            at: Date.now(),
          };
        });
      if (records.length === 0) {
        setScanNote({ kind: 'unparsed' });
        return;
      }
      await upsertMemoryConflicts(characterId, records);
      await reload();
      setScanNote({
        kind: 'done',
        conflicts: records.filter(item => item.conflict).length,
        judged: records.length,
      });
    } catch (caught) {
      setError((caught && caught.message) || t('memory.provenance.scanFail'));
    } finally {
      setScanning(false);
    }
  }, [characterId, conflicts, memories, reload, scanning, t]);

  const openEvidence = useCallback(async memory => {
    if (!memory) return;
    setEvidence({ loading: true, memory, chain: null });
    try {
      const messages = await getMessagesBySession(String(memory.sessionId || ''));
      setEvidence({
        loading: false,
        memory,
        chain: buildEvidenceChain({ memory, messages }),
      });
    } catch (caught) {
      setEvidence({
        loading: false,
        memory,
        chain: buildEvidenceChain({ memory, messages: [] }),
        error: (caught && caught.message) || t('memory.provenance.loadFail'),
      });
    }
  }, [t]);

  const onDeleteMemory = useCallback(memory => {
    if (!memory) return;
    Alert.alert(
      t('memory.provenance.evidence.deleteConfirm.title'),
      t('memory.provenance.evidence.deleteConfirm.body'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: async () => {
            try {
              await dropMemories([memoryKey(memory)]);
              setEvidence(null);
              await reload();
            } catch (caught) {
              setError((caught && caught.message) || t('memory.provenance.actionFail'));
            }
          },
        },
      ]
    );
  }, [dropMemories, reload, t]);

  const renderRoleLabel = role => (
    role === 'user'
      ? t('memory.provenance.evidence.roleUser')
      : t('memory.provenance.evidence.roleAssistant')
  );

  const renderEvidenceView = () => {
    const memory = evidence.memory;
    const chain = evidence.chain;
    const sources = memorySources(memory);
    return (
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <Card style={styles.card}>
          <Text style={styles.cardTitle}>{t('memory.provenance.evidence.memory')}</Text>
          <Text style={styles.memoryText}>{String(memory.text || '')}</Text>
          <Text style={styles.metaLine}>
            {`${sessionNameOf(memory.sessionId)} · ${formatTime(memory.at)}`}
          </Text>
          {memory.origin === 'merged' ? (
            <Text style={styles.mergedNote}>{t('memory.provenance.evidence.mergedNote')}</Text>
          ) : null}
        </Card>

        {sources.length > 1 ? (
          <Card style={styles.card}>
            <Text style={styles.cardTitle}>{t('memory.provenance.evidence.mergedFrom')}</Text>
            {sources.map(source => (
              <View key={`${source.sessionId}:${source.messageId}:${source.at}`} style={styles.sourceRow}>
                <Text style={styles.sourceMeta}>
                  {`${sessionNameOf(source.sessionId)} · ${formatTime(source.at)}`}
                </Text>
                <Text style={styles.sourceText}>{source.text}</Text>
              </View>
            ))}
          </Card>
        ) : null}

        {evidence.loading ? (
          <View style={styles.loadingRow}>
            <ActivityIndicator size="small" color={theme.colors.primary} />
            <Text style={styles.metaLine}>{t('memory.provenance.evidence.loading')}</Text>
          </View>
        ) : null}

        {evidence.error ? <Text style={styles.errorText}>{evidence.error}</Text> : null}

        {!evidence.loading && chain && chain.found === false ? (
          <Card style={styles.card}>
            <Text style={styles.missingText}>{t('memory.provenance.evidence.missing')}</Text>
          </Card>
        ) : null}

        {!evidence.loading && chain && chain.found ? (
          <Card style={styles.card}>
            <Text style={styles.cardTitle}>
              {t('memory.provenance.evidence.session', { name: sessionNameOf(memory.sessionId) })}
            </Text>
            {chain.before.map(item => (
              <View key={item.id || `${item.at}-b`} style={styles.chainRow}>
                <Text style={styles.chainMeta}>{renderRoleLabel(item.role)}</Text>
                <Text style={styles.chainText} numberOfLines={3}>{item.text}</Text>
              </View>
            ))}
            <View style={styles.chainSource}>
              <Text style={styles.chainSourceBadge}>{t('memory.provenance.evidence.source')}</Text>
              <Text style={styles.chainMeta}>{renderRoleLabel(chain.source.role)}</Text>
              <Text style={styles.chainSourceText}>{chain.source.text}</Text>
            </View>
            {chain.after.map(item => (
              <View key={item.id || `${item.at}-a`} style={styles.chainRow}>
                <Text style={styles.chainMeta}>{renderRoleLabel(item.role)}</Text>
                <Text style={styles.chainText} numberOfLines={3}>{item.text}</Text>
              </View>
            ))}
            <Text style={styles.hint}>{t('memory.provenance.evidence.contextHint')}</Text>
          </Card>
        ) : null}

        <View style={styles.footerRow}>
          <GhostButton
            title={t('memory.provenance.evidence.delete')}
            onPress={() => onDeleteMemory(memory)}
          />
        </View>
      </ScrollView>
    );
  };

  const renderConflictCard = record => {
    const busy = busyKey === record.key;
    return (
      <Card key={record.key} style={styles.conflictCard}>
        <View style={styles.conflictHead}>
          <Ionicons name="warning-outline" size={15} color={theme.colors.star} />
          <Text style={styles.conflictTitle}>{t('memory.provenance.conflicts.pair')}</Text>
        </View>
        <View style={styles.conflictSide}>
          <Text style={styles.conflictSideLabel}>{t('memory.provenance.conflicts.sideA')}</Text>
          <Text style={styles.conflictSideText}>{record.aText}</Text>
        </View>
        <View style={styles.conflictSide}>
          <Text style={styles.conflictSideLabel}>{t('memory.provenance.conflicts.sideB')}</Text>
          <Text style={styles.conflictSideText}>{record.bText}</Text>
        </View>
        {record.reason ? (
          <Text style={styles.conflictReason}>
            {t('memory.provenance.conflicts.reason', { reason: record.reason })}
          </Text>
        ) : null}
        <View style={styles.conflictActions}>
          <TouchableOpacity
            style={[styles.actionButton, busy && styles.actionDisabled]}
            onPress={() => onKeep(record, 'a')}
            disabled={busy}
            accessibilityRole="button"
          >
            <Text style={styles.actionText}>{t('memory.provenance.conflicts.keepA')}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.actionButton, busy && styles.actionDisabled]}
            onPress={() => onKeep(record, 'b')}
            disabled={busy}
            accessibilityRole="button"
          >
            <Text style={styles.actionText}>{t('memory.provenance.conflicts.keepB')}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.actionButton, styles.actionPrimary, busy && styles.actionDisabled]}
            onPress={() => onMerge(record)}
            disabled={busy}
            accessibilityRole="button"
          >
            {busy ? (
              <ActivityIndicator size="small" color={theme.colors.primaryContrast} />
            ) : (
              <Text style={styles.actionPrimaryText}>{t('memory.provenance.conflicts.merge')}</Text>
            )}
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.actionButton, busy && styles.actionDisabled]}
            onPress={() => onIgnore(record)}
            disabled={busy}
            accessibilityRole="button"
          >
            <Text style={styles.actionText}>{t('memory.provenance.conflicts.ignore')}</Text>
          </TouchableOpacity>
        </View>
      </Card>
    );
  };

  const renderListView = () => {
    if (loading) {
      return (
        <View style={styles.loadingRow}>
          <ActivityIndicator size="small" color={theme.colors.primary} />
          <Text style={styles.metaLine}>{t('memory.provenance.loading')}</Text>
        </View>
      );
    }
    if (memories.length === 0) {
      return (
        <EmptyState
          icon="git-network-outline"
          title={t('memory.provenance.empty.title')}
          description={t('memory.provenance.empty.body')}
        />
      );
    }
    return (
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <Card style={styles.card}>
          <View style={styles.overviewRow}>
            <Text style={styles.overviewValue}>{memories.length}</Text>
            <Text style={styles.overviewLabel}>{t('memory.provenance.countLabel')}</Text>
          </View>
          <PrimaryButton
            title={scanning ? t('memory.provenance.scanning') : t('memory.provenance.scan')}
            onPress={onScan}
            loading={scanning}
            disabled={scanning}
            style={styles.scanButton}
          />
          {scanNote && scanNote.kind === 'none' ? (
            <Text style={styles.noteLine}>{t('memory.provenance.scan.none')}</Text>
          ) : null}
          {scanNote && scanNote.kind === 'unparsed' ? (
            <Text style={styles.noteLine}>{t('memory.provenance.scan.unparsed')}</Text>
          ) : null}
          {scanNote && scanNote.kind === 'done' ? (
            <Text style={styles.noteLine}>
              {t('memory.provenance.scan.done', {
                judged: scanNote.judged,
                conflicts: scanNote.conflicts,
              })}
            </Text>
          ) : null}
          {scanNote && scanNote.kind === 'kept' ? (
            <Text style={styles.noteLine}>{t('memory.provenance.keep.done')}</Text>
          ) : null}
          {scanNote && scanNote.kind === 'merged' ? (
            <Text style={styles.noteLine}>{t('memory.provenance.merge.done')}</Text>
          ) : null}
          <Text style={styles.hint}>{t('memory.provenance.scanHint')}</Text>
        </Card>

        {pending.length > 0 ? (
          <>
            <Text style={styles.sectionTitle}>
              {t('memory.provenance.conflicts.title', { count: pending.length })}
            </Text>
            {pending.map(renderConflictCard)}
          </>
        ) : null}

        <Text style={styles.sectionTitle}>
          {t('memory.provenance.bySession', { count: groups.length })}
        </Text>
        {groups.map(group => (
          <Card key={group.sessionId || 'orphan'} style={styles.card}>
            <View style={styles.groupHead}>
              <Text style={styles.groupTitle} numberOfLines={1}>{group.name}</Text>
              <Text style={styles.groupCount}>{group.items.length}</Text>
            </View>
            {group.items.map(item => {
              const hits = badges.get(memoryKey(item)) || [];
              return (
                <TouchableOpacity
                  key={memoryKey(item)}
                  style={styles.memoryRow}
                  onPress={() => openEvidence(item)}
                  activeOpacity={0.75}
                  accessibilityRole="button"
                >
                  <View style={styles.memoryMain}>
                    <Text style={styles.memoryText} numberOfLines={2}>{String(item.text || '')}</Text>
                    <Text style={styles.memoryMeta}>
                      {`${formatTime(item.at)} · ${renderRoleLabel(item.role)}`}
                    </Text>
                  </View>
                  <View style={styles.badgeColumn}>
                    {item.origin === 'merged' ? (
                      <View style={styles.badgeMerged}>
                        <Text style={styles.badgeMergedText}>{t('memory.provenance.badge.merged')}</Text>
                      </View>
                    ) : null}
                    {hits.length > 0 ? (
                      <View style={styles.badgeConflict}>
                        <Text style={styles.badgeConflictText}>{t('memory.provenance.badge.conflict')}</Text>
                      </View>
                    ) : null}
                  </View>
                  <Ionicons name="chevron-forward" size={16} color={theme.colors.textFaint} />
                </TouchableOpacity>
              );
            })}
          </Card>
        ))}
      </ScrollView>
    );
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.container}>
        <View style={styles.header}>
          {evidence ? (
            <TouchableOpacity
              onPress={() => setEvidence(null)}
              hitSlop={8}
              style={styles.headerBack}
              accessibilityLabel={t('common.back')}
            >
              <Ionicons name="chevron-back" size={22} color={theme.colors.textMuted} />
            </TouchableOpacity>
          ) : null}
          <View style={styles.headerTitles}>
            <Text style={styles.title}>
              {evidence
                ? t('memory.provenance.evidence.title')
                : t('memory.provenance.title')}
            </Text>
            <Text style={styles.subtitle} numberOfLines={1}>
              {String(characterName || '').trim() || t('memory.unnamedCharacter')}
            </Text>
          </View>
          <TouchableOpacity onPress={onClose} hitSlop={8} accessibilityLabel={t('common.close')}>
            <Ionicons name="close" size={22} color={theme.colors.textMuted} />
          </TouchableOpacity>
        </View>

        {error ? <Text style={styles.errorBanner}>{error}</Text> : null}

        {evidence ? renderEvidenceView() : renderListView()}
      </View>
    </Modal>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 10,
  },
  headerBack: { marginRight: 6 },
  headerTitles: { flex: 1 },
  title: { color: theme.colors.text, fontSize: fonts.scaled(17), fontWeight: '700' },
  subtitle: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), marginTop: 2 },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 20, paddingBottom: 32 },
  card: { marginBottom: tokens.metrics.cardGap },
  cardTitle: { color: theme.colors.text, fontSize: fonts.scaled(14), fontWeight: '700', marginBottom: 6 },
  overviewRow: { flexDirection: 'row', alignItems: 'baseline' },
  overviewValue: { color: theme.colors.primary, fontSize: fonts.scaled(26), fontWeight: '800' },
  overviewLabel: { color: theme.colors.textMuted, fontSize: fonts.scaled(12), marginLeft: 6 },
  scanButton: { marginTop: 12 },
  noteLine: { color: theme.colors.primarySoft, fontSize: fonts.scaled(12), marginTop: 10, lineHeight: fonts.scaled(18) },
  hint: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), lineHeight: fonts.scaled(16), marginTop: 10 },
  sectionTitle: {
    color: theme.colors.textMuted,
    fontSize: fonts.scaled(12),
    fontWeight: '800',
    marginTop: 6,
    marginBottom: 8,
  },
  groupHead: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  groupTitle: { color: theme.colors.text, fontSize: fonts.scaled(13), fontWeight: '700', flex: 1 },
  groupCount: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), marginLeft: 8 },
  memoryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 9,
    borderTopWidth: tokens.border.thin,
    borderTopColor: theme.colors.divider,
  },
  memoryMain: { flex: 1, marginRight: 8 },
  memoryText: { color: theme.colors.text, fontSize: fonts.scaled(13), lineHeight: fonts.scaled(19) },
  memoryMeta: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), marginTop: 3 },
  metaLine: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), marginTop: 4 },
  badgeColumn: { alignItems: 'flex-end', marginRight: 6 },
  badgeConflict: {
    borderRadius: tokens.radius.sm,
    backgroundColor: theme.colors.dangerSoft || theme.colors.surfaceBorder,
    paddingHorizontal: 6,
    paddingVertical: 2,
    marginBottom: 2,
  },
  badgeConflictText: { color: theme.colors.background, fontSize: fonts.scaled(10), fontWeight: '800' },
  badgeMerged: {
    borderRadius: tokens.radius.sm,
    backgroundColor: theme.colors.surfaceBorder,
    paddingHorizontal: 6,
    paddingVertical: 2,
    marginBottom: 2,
  },
  badgeMergedText: { color: theme.colors.textMuted, fontSize: fonts.scaled(10), fontWeight: '800' },
  conflictCard: { borderWidth: tokens.border.thin, borderColor: theme.colors.star },
  conflictHead: { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
  conflictTitle: { color: theme.colors.text, fontSize: fonts.scaled(13), fontWeight: '700', marginLeft: 5 },
  conflictSide: { marginTop: 6 },
  conflictSideLabel: { color: theme.colors.textFaint, fontSize: fonts.scaled(10), fontWeight: '800' },
  conflictSideText: { color: theme.colors.text, fontSize: fonts.scaled(12), lineHeight: fonts.scaled(18), marginTop: 2 },
  conflictReason: { color: theme.colors.textMuted, fontSize: fonts.scaled(11), marginTop: 8, lineHeight: fonts.scaled(16) },
  conflictActions: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 10 },
  actionButton: {
    borderRadius: tokens.radius.sm,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginRight: 8,
    marginTop: 6,
  },
  actionPrimary: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  actionDisabled: { opacity: tokens.opacity.disabled },
  actionText: { color: theme.colors.textMuted, fontSize: fonts.scaled(12), fontWeight: '700' },
  actionPrimaryText: { color: theme.colors.primaryContrast, fontSize: fonts.scaled(12), fontWeight: '700' },
  sourceRow: { marginTop: 8, paddingTop: 8, borderTopWidth: tokens.border.thin, borderTopColor: theme.colors.divider },
  sourceMeta: { color: theme.colors.textFaint, fontSize: fonts.scaled(10) },
  sourceText: { color: theme.colors.textMuted, fontSize: fonts.scaled(12), lineHeight: fonts.scaled(18), marginTop: 3 },
  mergedNote: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), marginTop: 6, lineHeight: fonts.scaled(16) },
  loadingRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 12 },
  chainRow: { marginTop: 8 },
  chainMeta: { color: theme.colors.textFaint, fontSize: fonts.scaled(10), fontWeight: '700' },
  chainText: { color: theme.colors.textMuted, fontSize: fonts.scaled(12), lineHeight: fonts.scaled(18), marginTop: 2 },
  chainSource: {
    marginTop: 10,
    paddingTop: 10,
    paddingHorizontal: 10,
    paddingBottom: 10,
    borderRadius: tokens.radius.md,
    backgroundColor: theme.colors.primaryAlpha ? theme.colors.primaryAlpha(0.12) : theme.colors.surfaceAlt,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.primaryMuted,
  },
  chainSourceBadge: { color: theme.colors.primarySoft, fontSize: fonts.scaled(10), fontWeight: '800', marginBottom: 4 },
  chainSourceText: { color: theme.colors.text, fontSize: fonts.scaled(13), lineHeight: fonts.scaled(19), marginTop: 2 },
  missingText: { color: theme.colors.textMuted, fontSize: fonts.scaled(12), lineHeight: fonts.scaled(18) },
  footerRow: { flexDirection: 'row', justifyContent: 'center', marginTop: 8 },
  errorText: { color: theme.colors.danger, fontSize: fonts.scaled(12), marginTop: 4, marginBottom: 8 },
  errorBanner: {
    color: theme.colors.danger,
    fontSize: fonts.scaled(12),
    paddingHorizontal: 20,
    paddingBottom: 8,
    lineHeight: fonts.scaled(18),
  },
});
