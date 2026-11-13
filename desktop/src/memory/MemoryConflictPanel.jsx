// 记忆冲突（桌面）：检测「同一件事、结论互相矛盾」的向量记忆，并逐对处置。
//
// 对应手机 memory/MemoryProvenanceModal 的冲突那一半。整条链路都在共享层：
//   · memory/conflict.js —— candidatePairs（向量相似度挑候选）、buildConflictPrompt、
//     parseConflictResponse、buildMergePrompt、parseMergeResponse、pendingConflicts；
//   · storage/memoryConflicts.js —— 三态读 + 串行写入；
//   · storage/vector.js —— updateVectorIndex（保留 A/B 时删掉另一条）。
//
// 纪律（照抄手机）：**任何一条记忆的消失或改写都必须是用户点出来的**——
// 检测只记录判定，不改记忆；保留/合并都要用户再点一次。
import { useCallback, useEffect, useState } from 'react';

import { useTranslation } from '../../../src/i18n/I18nContext.js';
import {
  RESOLUTION_KEPT_A,
  RESOLUTION_KEPT_B,
  RESOLUTION_IGNORED,
  buildConflictPrompt,
  buildMergePrompt,
  candidatePairs,
  parseConflictResponse,
  parseMergeResponse,
  pendingConflicts,
} from '../../../src/memory/conflict.js';
import {
  getMemoryConflictsStatus,
  resolveMemoryConflict,
  upsertMemoryConflicts,
} from '../../../src/storage/memoryConflicts.js';
import { getVectorIndexStatus, updateVectorIndex } from '../../../src/storage/vector.js';
import { getApiConfigs } from '../../../src/storage/apiConfigs.js';
import { getConfigFingerprint, sendChatMessage } from '../../../src/network/api.js';
import { Alert } from '../platform/alert.js';
import { Button, Card, Row } from '../settings/ui.jsx';

export default function MemoryConflictPanel({ character, palette, fonts }) {
  const { t } = useTranslation();
  const [records, setRecords] = useState([]);
  const [corrupt, setCorrupt] = useState(false);
  const [busy, setBusy] = useState(false);
  const [scanNote, setScanNote] = useState('');

  const characterId = String((character && character.id) || '');

  const load = useCallback(async () => {
    if (!characterId) return;
    try {
      const status = await getMemoryConflictsStatus(characterId);
      setCorrupt(status.status === 'corrupt');
      setRecords(Array.isArray(status.records) ? status.records : []);
    } catch (error) {
      // 读坏不冒充「没有冲突」：原始数据已备份，重扫会重建。
      setCorrupt(true);
      setRecords([]);
    }
  }, [characterId]);

  useEffect(() => { load(); }, [load]);

  const pending = pendingConflicts(records);

  // 检测：先用向量相似度挑候选，再让模型逐对判定是否矛盾。
  const scan = async () => {
    if (!characterId || busy) return;
    setBusy(true);
    setScanNote('');
    try {
      const indexStatus = await getVectorIndexStatus(characterId);
      if (indexStatus.status !== 'ok') {
        setScanNote(t('memory.provenance.corrupt.body'));
        return;
      }
      const pairs = candidatePairs(indexStatus.index, { skipKeys: records.map(item => item.key) });
      if (pairs.length === 0) {
        setScanNote(t('memory.provenance.scan.none'));
        return;
      }
      const { configs, activeId } = await getApiConfigs();
      const current = configs.find(item => item.id === activeId) || configs[0];
      if (!current) throw new Error(t('forge.error.noModel'));
      const raw = await sendChatMessage(buildConflictPrompt(pairs), {
        stream: false,
        expectedConfigId: String(current.id || ''),
        expectedConfigFingerprint: getConfigFingerprint(current),
      });
      const judged = parseConflictResponse(raw, pairs);
      const parsedCount = judged.filter(item => item.parsed).length;
      if (parsedCount === 0) {
        setScanNote(t('memory.provenance.scan.unparsed'));
        return;
      }
      // 只把「判定为矛盾」的写进记录（无关的对也记一份，避免下次重复判定花钱）。
      await upsertMemoryConflicts(characterId, judged.map(item => ({
        key: item.key,
        conflict: item.conflict,
        reason: item.reason,
        resolution: '',
        aKey: item.key.split('|')[0],
        bKey: item.key.split('|')[1],
      })));
      await load();
      setScanNote(t('memory.provenance.scan.done', {
        judged: parsedCount,
        conflicts: judged.filter(item => item.conflict).length,
      }));
    } catch (error) {
      setScanNote(t('memory.provenance.scanFail'));
    } finally {
      setBusy(false);
    }
  };

  // 保留 A / B：删掉另一条并标记已解决。
  const keep = async (record, side) => {
    if (!record || busy) return;
    setBusy(true);
    try {
      const dropKey = side === RESOLUTION_KEPT_A ? record.bKey : record.aKey;
      await updateVectorIndex(characterId, list => (
        Array.isArray(list) ? list.filter(item => String(item.key || '') !== String(dropKey || '')) : list
      ));
      await resolveMemoryConflict(
        characterId,
        record.key,
        side === RESOLUTION_KEPT_A ? RESOLUTION_KEPT_A : RESOLUTION_KEPT_B
      );
      await load();
      Alert.alert(t('memory.provenance.keep.done'));
    } catch (error) {
      Alert.alert(t('memory.provenance.actionFail'));
    } finally {
      setBusy(false);
    }
  };

  // AI 合并：把两条矛盾记忆合成一条「更新后的」，替换掉两条并标记已合并。
  const merge = async record => {
    if (!record || busy) return;
    setBusy(true);
    try {
      const indexStatus = await getVectorIndexStatus(characterId);
      if (indexStatus.status !== 'ok') {
        Alert.alert(t('memory.provenance.merge.fail'));
        return;
      }
      const list = Array.isArray(indexStatus.index) ? indexStatus.index : [];
      const left = list.find(item => String(item.key || '') === String(record.aKey || ''));
      const right = list.find(item => String(item.key || '') === String(record.bKey || ''));
      if (!left || !right) {
        Alert.alert(t('memory.provenance.merge.missing'));
        return;
      }
      const { configs, activeId } = await getApiConfigs();
      const current = configs.find(item => item.id === activeId) || configs[0];
      if (!current) throw new Error(t('forge.error.noModel'));
      const raw = await sendChatMessage(buildMergePrompt(left, right), {
        stream: false,
        expectedConfigId: String(current.id || ''),
        expectedConfigFingerprint: getConfigFingerprint(current),
      });
      const merged = parseMergeResponse(raw);
      if (!merged || !String(merged.text || '').trim()) {
        Alert.alert(t('memory.provenance.merge.empty'));
        return;
      }
      const dropKeys = new Set([String(record.aKey || ''), String(record.bKey || '')]);
      await updateVectorIndex(characterId, current2 => {
        const kept = (Array.isArray(current2) ? current2 : [])
          .filter(item => !dropKeys.has(String(item.key || '')));
        return [...kept, { ...left, key: `merged-${Date.now()}`, text: String(merged.text), origin: 'merged', mergedFrom: [left, right] }];
      });
      await resolveMemoryConflict(characterId, record.key, 'merged');
      await load();
      Alert.alert(t('memory.provenance.merge.done'));
    } catch (error) {
      Alert.alert(t('memory.provenance.merge.fail'));
    } finally {
      setBusy(false);
    }
  };

  const ignore = async record => {
    if (!record || busy) return;
    try {
      await resolveMemoryConflict(characterId, record.key, RESOLUTION_IGNORED);
      await load();
    } catch (error) {
      Alert.alert(t('memory.provenance.actionFail'));
    }
  };

  if (!characterId) return null;

  return (
    <Card
      title={pending.length > 0
        ? t('memory.provenance.conflicts.title', { count: pending.length })
        : t('memory.provenance.scan')}
      hint={t('memory.provenance.scanHint')}
      palette={palette}
      fonts={fonts}
    >
      {corrupt ? (
        <div style={{ fontSize: fonts.scaled(11), color: palette.danger || '#ff5a5f', lineHeight: 1.6 }}>
          {t('memory.provenance.conflicts.corrupt')}
        </div>
      ) : null}
      <Row>
        <Button
          label={busy ? t('memory.provenance.scanning') : t('memory.provenance.scan')}
          onClick={scan}
          palette={palette}
          fonts={fonts}
          primary
          disabled={busy}
        />
      </Row>
      {scanNote ? (
        <div style={{ fontSize: fonts.scaled(11), color: palette.textMuted, lineHeight: 1.6 }}>{scanNote}</div>
      ) : null}
      {pending.map(record => (
        <div
          key={record.key}
          style={{
            border: `1px solid ${palette.divider}`,
            borderRadius: 8,
            padding: '8px 10px',
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          }}
        >
          <div style={{ fontSize: fonts.scaled(11), color: palette.danger || '#ff5a5f' }}>
            {t('memory.provenance.conflicts.pair')}
          </div>
          {record.reason ? (
            <div style={{ fontSize: fonts.scaled(10), color: palette.textFaint }}>
              {t('memory.provenance.conflicts.reason', { reason: record.reason })}
            </div>
          ) : null}
          <div style={{ fontSize: fonts.scaled(10), color: palette.textMuted }}>
            {t('memory.provenance.conflicts.sideA')} · {String(record.aKey || '')}
          </div>
          <div style={{ fontSize: fonts.scaled(10), color: palette.textMuted }}>
            {t('memory.provenance.conflicts.sideB')} · {String(record.bKey || '')}
          </div>
          <Row>
            <Button label={t('memory.provenance.conflicts.keepA')} onClick={() => keep(record, RESOLUTION_KEPT_A)} palette={palette} fonts={fonts} disabled={busy} />
            <Button label={t('memory.provenance.conflicts.keepB')} onClick={() => keep(record, RESOLUTION_KEPT_B)} palette={palette} fonts={fonts} disabled={busy} />
            <Button label={t('memory.provenance.conflicts.merge')} onClick={() => merge(record)} palette={palette} fonts={fonts} disabled={busy} />
            <Button label={t('memory.provenance.conflicts.ignore')} onClick={() => ignore(record)} palette={palette} fonts={fonts} disabled={busy} />
          </Row>
        </div>
      ))}
    </Card>
  );
}
