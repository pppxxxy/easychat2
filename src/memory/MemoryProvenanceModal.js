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
//
// 读失败必须与「确实没有」分开渲染：索引、冲突记录、证据链三处都按 ok/missing/corrupt
// 三态读，绝不把「读不出来」说成「没有记忆」或「消息已被删除」（先例：
// proactive/proactiveMessage.js:21-40 的三态权限、storage/worldMap.js:19-27 的
// getWorldMapStatus、MemoryCheckupModal 的 sessions.error 分支）。

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

import { sendChatMessage } from '../network/api.js';
import { getMessagesBySessionStatus } from '../storage/sessions.js';
import { getVectorIndexStatus, getVectorMemoryConfig, updateVectorIndex } from '../storage/vector.js';
import { getCharacterLibrary } from '../storage/characters.js';
import { applyRegexScripts, REGEX_PLACEMENT } from '../prompt/regexEngine.js';
import { getCachedDisplayText } from './displayTextCache.js';
import {
  getMemoryConflictsStatus,
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

// 角色消息按 AI 输出、用户消息按用户输入应用展示正则——与 ChatScreen.js:583-616 同一判定。
const placementOfRole = role => (role === 'assistant' ? REGEX_PLACEMENT.AI_OUTPUT : REGEX_PLACEMENT.USER_INPUT);

// 证据链 / 合并来源的正文必须与聊天页**同源脱敏**：聊天页渲染走 applyRegexScripts(..., { mode:'display' })
//（ChatScreen.js:588-615），而角色卡正则最常见的用途恰恰是隐藏 / 改写内容——面板直接渲染
// getMessagesBySessionStatus 读到的**原始** message.text，就是把「聊天页看不到的文字」在派生视图里全文复现
//（同仓脱敏纪律：secretStore.js:15-17、cardForge/preview.js:60-68；depth 0 同 preview，缓存复用 displayTextCache）。
export function maskEvidenceText(item, scripts, placement) {
  return getCachedDisplayText(item, scripts, placement, 0, () => applyRegexScripts(
    String((item && item.text) || ''), scripts, placement, { mode: 'display', depth: 0 }
  ));
}

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
  // 两个数据源各自的读盘状态（'' | 'ok' | 'missing' | 'corrupt'）。
  // 为什么单独存状态：读失败时 getVectorIndex/getMemoryConflicts 都只会返回空数组
  // （storage/io.js readJsonStatus 全程 try/catch、从不抛），压成空数组后
  // 「数据损坏」与「确实没有记忆」在界面上完全同形。
  const [indexStatus, setIndexStatus] = useState('');
  const [conflictsStatus, setConflictsStatus] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [scanning, setScanning] = useState(false);
  const [scanNote, setScanNote] = useState(null);
  const [busyKey, setBusyKey] = useState('');
  const [evidence, setEvidence] = useState(null);
  // 脱敏依据（角色卡正则）按角色懒加载一次并缓存：解析走角色库**唯一公开入口** getCharacterLibrary
  //（先例 storage/memoryOwnership.js:139 的 library.find(id)）。读失败**不静默**：failed 让证据链如实
  // 标注「下面是未过滤的原文」——否则「读不出正则」会被当成「没有正则」，用户以为已经脱敏过了。
  const scriptsRef = useRef({ id: '', list: [], failed: false });

  const resolveScripts = useCallback(async () => {
    if (scriptsRef.current.id === characterId) return scriptsRef.current;
    try {
      const owner = ((await getCharacterLibrary()) || [])
        .find(item => item && String(item.id || '') === String(characterId || ''));
      scriptsRef.current = { id: characterId, list: (owner && owner.regexScripts) || [], failed: false };
    } catch (caught) {
      scriptsRef.current = { id: characterId, list: [], failed: true };
    }
    return scriptsRef.current;
  }, [characterId]);

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
      setIndexStatus('missing');
      setConflictsStatus('missing');
      return;
    }
    // 用 *Status 版本而不是 getVectorIndex/getMemoryConflicts：后者把读失败压成 []，
    // 面板就再也分不出「损坏」和「没有」。这两个函数本身不抛（readJsonStatus 从不抛），
    // 调用方保留 .catch 只是为了兜住将来可能的实现变化。
    const [indexState, conflictState] = await Promise.all([
      getVectorIndexStatus(characterId),
      getMemoryConflictsStatus(characterId),
    ]);
    setMemories(Array.isArray(indexState && indexState.index) ? indexState.index : []);
    setConflicts(Array.isArray(conflictState && conflictState.records) ? conflictState.records : []);
    setIndexStatus(String((indexState && indexState.status) || ''));
    setConflictsStatus(String((conflictState && conflictState.status) || ''));
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
      // 三态读消息体：corrupt 时 getMessagesBySession 同样只返回 []，
      // buildEvidenceChain 找不到 id 就会渲染 evidence.missing
      //（「原始消息已经不在了（消息被删除或重新生成过）」）——那是归错因：
      // 用户会以为是自己删了消息。读失败走独立文案，不复用 missing。
      const state = await getMessagesBySessionStatus(String(memory.sessionId || ''));
      if (state && state.status === 'corrupt') {
        setEvidence({
          loading: false,
          memory,
          chain: null,
          error: t('memory.provenance.evidence.readFail'),
          backup: true,
        });
        return;
      }
      // 证据链正文走 maskEvidenceText（display 口径正则，与聊天页同一份过滤）：读的是原始 message.text。
      const scripts = await resolveScripts();
      const maskMessage = item => ({
        ...item,
        text: maskEvidenceText(item, scripts.list, placementOfRole(item.role)),
      });
      setEvidence({
        loading: false,
        memory,
        chain: buildEvidenceChain({ memory, messages: (state ? state.messages : []).map(maskMessage) }),
        scripts,
      });
    } catch (caught) {
      setEvidence({
        loading: false,
        memory,
        chain: null,
        error: (caught && caught.message) || t('memory.provenance.loadFail'),
      });
    }
  }, [resolveScripts, t]);

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
    // 合并来源是 storage 快照（归一化不存 role，判不出 placement）：两种都过一遍，宁可多脱敏也不漏。
    const scripts = (evidence.scripts && evidence.scripts.list) || [];
    const maskSource = source => [REGEX_PLACEMENT.USER_INPUT, REGEX_PLACEMENT.AI_OUTPUT].reduce(
      (text, placement) => applyRegexScripts(text, scripts, placement, { mode: 'display', depth: 0 }),
      String((source && source.text) || '')
    );
    const chainRow = (item, suffix) => (
      <View key={item.id || `${item.at}-${suffix}`} style={styles.chainRow}>
        <Text style={styles.chainMeta}>{renderRoleLabel(item.role)}</Text>
        <Text style={styles.chainText} numberOfLines={3}>{item.text}</Text>
      </View>
    );
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
                <Text style={styles.sourceText}>{maskSource(source)}</Text>
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
        {evidence.error && evidence.backup ? (
          <Text style={styles.hint}>{t('memory.provenance.evidence.readFailBackup')}</Text>
        ) : null}
        {/* 正则读不出来 = 没有可用的脱敏依据，正文就是盘上原文：如实说明，别让「读不出」像「已过滤」。 */}
        {evidence.scripts && evidence.scripts.failed ? (
          <Text style={styles.hint}>{t('memory.provenance.evidence.rawTextWarning')}</Text>
        ) : null}

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
            {chain.before.map(item => chainRow(item, 'b'))}
            <View style={styles.chainSource}>
              <Text style={styles.chainSourceBadge}>{t('memory.provenance.evidence.source')}</Text>
              <Text style={styles.chainMeta}>{renderRoleLabel(chain.source.role)}</Text>
              <Text style={styles.chainSourceText}>{chain.source.text}</Text>
            </View>
            {chain.after.map(item => chainRow(item, 'a'))}
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
    // 索引损坏：走独立空态，绝不落到下面的「还没有向量记忆」——那是在说
    // 「确实没有」，而这里是「读不出来」。corrupt 时 storage 已先备份原始串
    //（backupCorruptValue），把这一点告诉用户，免得他以为数据已经被抹掉。
    if (indexStatus === 'corrupt') {
      return (
        <EmptyState
          icon="alert-circle-outline"
          title={t('memory.provenance.corrupt.title')}
          description={t('memory.provenance.corrupt.body')}
          action={<Text style={styles.hint}>{t('memory.provenance.corrupt.backup')}</Text>}
        />
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
          {/* 冲突记录读失败：如实说明「下面列出的冲突可能不完整」，
              而不是让它看起来像「已判定过、没有冲突」。 */}
          {conflictsStatus === 'corrupt' ? (
            <Text style={styles.errorText}>{t('memory.provenance.conflicts.corrupt')}</Text>
          ) : null}
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
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingTop: 16, paddingBottom: 10 },
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
  noteLine: { color: theme.colors.accentText, fontSize: fonts.scaled(12), marginTop: 10, lineHeight: fonts.scaled(18) },
  hint: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), lineHeight: fonts.scaled(16), marginTop: 10 },
  sectionTitle: { color: theme.colors.textMuted, fontSize: fonts.scaled(12), fontWeight: '800', marginTop: 6, marginBottom: 8 },
  groupHead: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  groupTitle: { color: theme.colors.text, fontSize: fonts.scaled(13), fontWeight: '700', flex: 1 },
  groupCount: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), marginLeft: 8 },
  memoryRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 9, borderTopWidth: tokens.border.thin, borderTopColor: theme.colors.divider },
  memoryMain: { flex: 1, marginRight: 8 },
  memoryText: { color: theme.colors.text, fontSize: fonts.scaled(13), lineHeight: fonts.scaled(19) },
  memoryMeta: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), marginTop: 3 },
  metaLine: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), marginTop: 4 },
  badgeColumn: { alignItems: 'flex-end', marginRight: 6 },
  badgeConflict: { borderRadius: tokens.radius.sm, backgroundColor: theme.colors.dangerSoft || theme.colors.surfaceBorder, paddingHorizontal: 6, paddingVertical: 2, marginBottom: 2 },
  badgeConflictText: { color: theme.colors.background, fontSize: fonts.scaled(10), fontWeight: '800' },
  badgeMerged: { borderRadius: tokens.radius.sm, backgroundColor: theme.colors.surfaceBorder, paddingHorizontal: 6, paddingVertical: 2, marginBottom: 2 },
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
    borderRadius: tokens.radius.sm, borderWidth: tokens.border.thin, borderColor: theme.colors.surfaceBorder,
    paddingHorizontal: 10, paddingVertical: 6, marginRight: 8, marginTop: 6,
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
    marginTop: 10, paddingTop: 10, paddingHorizontal: 10, paddingBottom: 10, borderRadius: tokens.radius.md,
    backgroundColor: theme.colors.primaryAlpha ? theme.colors.primaryAlpha(0.12) : theme.colors.surfaceAlt,
    borderWidth: tokens.border.thin, borderColor: theme.colors.primaryMuted,
  },
  chainSourceBadge: { color: theme.colors.accentText, fontSize: fonts.scaled(10), fontWeight: '800', marginBottom: 4 },
  chainSourceText: { color: theme.colors.text, fontSize: fonts.scaled(13), lineHeight: fonts.scaled(19), marginTop: 2 },
  missingText: { color: theme.colors.textMuted, fontSize: fonts.scaled(12), lineHeight: fonts.scaled(18) },
  footerRow: { flexDirection: 'row', justifyContent: 'center', marginTop: 8 },
  errorText: { color: theme.colors.danger, fontSize: fonts.scaled(12), marginTop: 4, marginBottom: 8 },
  errorBanner: { color: theme.colors.danger, fontSize: fonts.scaled(12), paddingHorizontal: 20, paddingBottom: 8, lineHeight: fonts.scaled(18) },
});
