// 记忆溯源（桌面）：把向量记忆摊开，看每条是从哪段对话的哪条消息切出来的。
//
// 对应手机 memory/MemoryProvenanceModal 的**溯源**部分。冲突检测与合并是同一面板的
// 另一半，由 memory/MemoryConflictPanel.jsx 承担（两者在设置页「向量记忆」分区里相邻渲染）。
//
// 数据与判定全部复用共享层：
//   · storage/vector.js 的 getVectorIndexStatus —— 三态读（ok / missing / corrupt）；
//   · memory/provenance.js 的 groupMemoriesBySession / memorySources / buildEvidenceChain；
//   · storage/sessions.js 的 getMessagesBySessionStatus + getSessions（拿会话名）。
//
// 三态纪律（照抄手机）：读失败绝不能渲染成「没有记忆」，也不能把「源消息已被删」
// 说成「找到了」——两者都会误导用户以为数据丢了或找错了。
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useApp } from '../../../src/context/AppContext.js';
import { useTranslation } from '../../../src/i18n/I18nContext.js';
import {
  buildEvidenceChain,
  groupMemoriesBySession,
  memoryKey,
  memorySources,
} from '../../../src/memory/provenance.js';
import { getMessagesBySessionStatus } from '../../../src/storage/sessions.js';
import { getVectorIndexStatus } from '../../../src/storage/vector.js';
import { Button, Card } from '../settings/ui.jsx';

export default function MemoryProvenancePanel({ palette, fonts, character }) {
  const { t } = useTranslation();
  const { sessions } = useApp();
  const [state, setState] = useState({ phase: 'loading', memories: [], corrupt: false });
  const [expanded, setExpanded] = useState('');
  // 证据链按需加载：一次读整段会话消息可能是几百条，点开哪条读哪条。
  const [evidence, setEvidence] = useState({});

  const load = useCallback(async () => {
    if (!character || !character.id) {
      setState({ phase: 'ready', memories: [], corrupt: false });
      return;
    }
    setState(current => ({ ...current, phase: 'loading' }));
    try {
      const status = await getVectorIndexStatus(character.id);
      // 三态：corrupt 与 missing 必须分开渲染（前者是「读不出来」，后者才是「没有」）。
      setState({
        phase: 'ready',
        memories: status.status === 'ok' && Array.isArray(status.index) ? status.index : [],
        corrupt: status.status === 'corrupt',
      });
    } catch (error) {
      setState({ phase: 'ready', memories: [], corrupt: true });
    }
  }, [character]);

  useEffect(() => { load(); }, [load]);

  const sessionNameOf = useMemo(() => {
    const map = new Map();
    (Array.isArray(sessions) ? sessions : []).forEach(item => {
      if (item && item.id) map.set(item.id, String(item.name || item.preview || ''));
    });
    return id => map.get(id) || '';
  }, [sessions]);

  const groups = useMemo(
    () => groupMemoriesBySession(state.memories, { sessionName: sessionNameOf }),
    [state.memories, sessionNameOf]
  );

  // 点开一条记忆 → 读它所在会话的消息 → 用共享层算证据链（源消息 + 前后各 2 条）。
  const toggleEvidence = async memory => {
    const key = memoryKey(memory);
    if (expanded === key) {
      setExpanded('');
      return;
    }
    setExpanded(key);
    if (evidence[key] !== undefined) return;
    const sessionId = String(memory.sessionId || '');
    if (!sessionId) {
      setEvidence(current => ({ ...current, [key]: { status: 'missing' } }));
      return;
    }
    try {
      const result = await getMessagesBySessionStatus(sessionId);
      if (result.status !== 'ok') {
        // 读不出来 ≠ 消息被删：如实标成读取失败。
        setEvidence(current => ({ ...current, [key]: { status: 'corrupt' } }));
        return;
      }
      setEvidence(current => ({
        ...current,
        [key]: { status: 'ok', chain: buildEvidenceChain({ memory, messages: result.messages }) },
      }));
    } catch (error) {
      setEvidence(current => ({ ...current, [key]: { status: 'corrupt' } }));
    }
  };

  const bodyLine = (source, chain, kind) => {
    const who = source.role === 'user' ? t('chat.bubble.me') : (source.speakerName || t('common.characterFallback'));
    return (
      <div
        key={`${kind}-${source.id}`}
        style={{
          fontSize: fonts.scaled(11),
          lineHeight: 1.6,
          color: kind === 'source' ? palette.text : palette.textMuted,
          borderLeft: `2px solid ${kind === 'source' ? (palette.primaryMuted || palette.primary) : palette.divider}`,
          paddingLeft: 8,
          marginBottom: 4,
        }}
      >
        <span style={{ fontWeight: kind === 'source' ? 700 : 400 }}>{who}</span>
        {': '}
        {String(source.text || '').slice(0, 200)}
      </div>
    );
  };

  if (!character || !character.id) {
    return (
      <Card title={t('memory.provenance.title')} palette={palette} fonts={fonts}>
        <div style={{ fontSize: fonts.scaled(12), color: palette.textMuted }}>
          {t('memory.provenance.sessionUnknown')}
        </div>
      </Card>
    );
  }

  return (
    <Card
      title={t('memory.provenance.title')}
      hint={t('memory.provenance.empty.body')}
      palette={palette}
      fonts={fonts}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Button
          label={state.phase === 'loading' ? t('memory.provenance.loading') : t('memory.provenance.title')}
          onClick={load}
          palette={palette}
          fonts={fonts}
          disabled={state.phase === 'loading'}
        />
        <span style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>
          {t('memory.provenance.countLabel')}: {state.memories.length}
        </span>
        <span style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>
          {t('memory.provenance.bySession', { count: groups.length })}
        </span>
      </div>

      {state.corrupt ? (
        <div style={{ fontSize: fonts.scaled(11), color: palette.danger || '#ff5a5f', lineHeight: 1.7 }}>
          {t('memory.provenance.corrupt.body')}
          <br />
          {t('memory.provenance.corrupt.backup')}
        </div>
      ) : null}

      {state.phase === 'ready' && !state.corrupt && groups.length === 0 ? (
        <div style={{ fontSize: fonts.scaled(11), color: palette.textMuted, lineHeight: 1.7 }}>
          {t('memory.provenance.empty.title')}
        </div>
      ) : null}

      {groups.map(group => (
        <div
          key={group.sessionId || 'unknown'}
          style={{
            border: `1px solid ${palette.divider}`,
            borderRadius: 10,
            padding: '8px 10px',
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          }}
        >
          <div style={{ fontSize: fonts.scaled(11), color: palette.primaryMuted || palette.primary }}>
            {group.name || (group.sessionId ? t('memory.provenance.sessionUnknown') : t('memory.provenance.sessionMissing'))}
            {' · '}
            {group.items.length}
          </div>
          {group.items.map(memory => {
            const key = memoryKey(memory);
            const sources = memorySources(memory);
            const open = expanded === key;
            const record = evidence[key];
            return (
              <div key={key}>
                <button
                  type="button"
                  onClick={() => toggleEvidence(memory)}
                  style={{
                    textAlign: 'left',
                    width: '100%',
                    background: open ? palette.surfaceAlt : 'transparent',
                    color: palette.text,
                    border: 'none',
                    borderRadius: 6,
                    padding: '5px 6px',
                    fontSize: fonts.scaled(12),
                    lineHeight: 1.6,
                    cursor: 'pointer',
                  }}
                >
                  {memory.origin === 'merged' ? `[${t('memory.provenance.badge.merged')}] ` : ''}
                  {String(memory.text || '').slice(0, 120)}
                </button>
                {open ? (
                  <div style={{ margin: '4px 0 6px 10px' }}>
                    {record === undefined ? (
                      <div style={{ fontSize: fonts.scaled(10), color: palette.textFaint }}>
                        {t('memory.provenance.loading')}
                      </div>
                    ) : null}
                    {record && record.status === 'corrupt' ? (
                      <div style={{ fontSize: fonts.scaled(10), color: palette.danger || '#ff5a5f' }}>
                        {t('memory.provenance.loadFail')}
                      </div>
                    ) : null}
                    {record && record.status === 'missing' ? (
                      <div style={{ fontSize: fonts.scaled(10), color: palette.textFaint }}>
                        {t('memory.provenance.sessionMissing')}
                      </div>
                    ) : null}
                    {record && record.status === 'ok' ? (
                      record.chain.found ? (
                        <>
                          {record.chain.before.map(item => bodyLine(item, record.chain, 'before'))}
                          {bodyLine(record.chain.source, record.chain, 'source')}
                          {record.chain.after.map(item => bodyLine(item, record.chain, 'after'))}
                        </>
                      ) : (
                        // 源消息不在索引能对上的位置：如实说「原始消息已不在」，不伪造。
                        <div style={{ fontSize: fonts.scaled(10), color: palette.textMuted }}>
                          {t('memory.provenance.sessionMissing')}
                        </div>
                      )
                    ) : null}
                    {sources.length > 1 ? (
                      <div style={{ fontSize: fonts.scaled(10), color: palette.textFaint }}>
                        {t('memory.provenance.badge.merged')} · {sources.length}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ))}
    </Card>
  );
}