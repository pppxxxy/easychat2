// 记忆页（桌面）：会话列表管理——与 Android「记忆」标签同一定位。
//
// 手机端结构（App.js 的 Tab.Screen + src/MemoryScreen.js）：
//   记忆标签 = 会话/对话的**管理界面**（筛选 chips、按时间分组、搜索、置顶、克隆、
//   删除、批量删除、记忆体检），不是设置页；向量记忆与记忆总结设置在「设置 → 向量记忆」。
// 桌面此前把它做成了设置页，导致顶栏还要塞一个「会话」入口——本文件按手机版归位。
//
// 桌面与手机的差异（只在交互层面，数据与判定全部复用共享层）：
//   · 手机按当前角色的会话进入；桌面顶栏是全局入口，故跨角色汇总并显示角色名；
//   · 无「看屏幕」线程与孤儿恢复（Android 专属能力，见扩展页说明）；
//   · 无群聊创建入口（桌面首版不支持群聊）。
import { useEffect, useMemo, useState } from 'react';

import { useTranslation } from '../../../src/i18n/I18nContext.js';
import { useApp } from '../../../src/context/AppContext.js';
import {
  buildSessionBadges,
  hasSessionUnread,
} from '../../../src/memory/memoryBuckets.js';
import { buildPreview } from '../../../src/context/sessionLibrary.js';
import { countMomentsBySessionIds } from '../../../src/moments/moments.js';
import { deleteMomentsBySessionIds, getMomentsStatus } from '../../../src/storage/moments.js';
import { updateSessionInfo } from '../../../src/storage/sessionList.js';
import { Alert } from '../platform/alert.js';
import GlobalSearchPanel from './GlobalSearchPanel.jsx';
import MemoryCheckupPanel from './MemoryCheckupPanel.jsx';
import OrphanRecoveryPanel from './OrphanRecoveryPanel.jsx';
import ScreenWatchThreadsPanel from './ScreenWatchThreadsPanel.jsx';
import {
  buildMemoryRows,
  flattenMemoryGroups,
  groupMemoryRows,
  memoryFilterOptions,
  selectableSessionIds,
} from './memoryListView.js';

function formatTime(timestamp, localeId) {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) return '';
  try {
    return new Date(value).toLocaleString(localeId === 'en' ? 'en-US' : 'zh-CN', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch (error) {
    return '';
  }
}

const ghost = (palette, fonts, extra = {}) => ({
  background: 'transparent',
  color: palette.textMuted,
  border: `1px solid ${palette.divider}`,
  borderRadius: 8,
  padding: '3px 8px',
  cursor: 'pointer',
  fontSize: fonts.scaled(11),
  ...extra,
});

export default function MemoryListScreen({ palette, fonts, onOpenSession, onTutorial, onCreateGroup }) {
  const { t, localeId } = useTranslation();
  const {
    sessions,
    characters,
    loaded,
    refreshSessions,
    pinSession,
    cloneSession,
    deleteSession,
    deleteSessions,
  } = useApp();

  const [filterId, setFilterId] = useState('all');
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState(false);
  const [selectedIds, setSelectedIds] = useState([]);
  const [checkupOpen, setCheckupOpen] = useState(false);
  // 全库搜索（对应手机记忆页的 SearchScreen）。
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const [recoverOpen, setRecoverOpen] = useState(false);
  const [expanded, setExpanded] = useState(() => new Set(['pinned', 'recent', 'older']));

  // 与手机一致：进入页面时重读会话列表（聊天页只写存储，不同步 Context 的 preview）。
  useEffect(() => {
    if (!loaded) return;
    refreshSessions().catch(() => {});
  }, [loaded, refreshSessions]);

  const rows = useMemo(
    () => buildMemoryRows({ sessions, characters, filterId, query }),
    [sessions, characters, filterId, query]
  );
  const groups = useMemo(() => groupMemoryRows(rows), [rows]);
  const items = useMemo(() => flattenMemoryGroups(groups, expanded), [groups, expanded]);
  const selectableIds = useMemo(() => selectableSessionIds(rows), [rows]);
  const allSelected = selectableIds.length > 0 && selectedIds.length === selectableIds.length;
  const filters = memoryFilterOptions(sessions);

  useEffect(() => {
    // 筛选/搜索变化后，把已选中但已不可见的会话剔掉（否则会删到看不见的会话）。
    setSelectedIds(current => current.filter(id => selectableIds.includes(id)));
  }, [selectableIds]);

  const exitEdit = () => {
    setEditing(false);
    setSelectedIds([]);
  };

  const toggleExpanded = groupId => {
    setExpanded(current => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  const onRename = (session) => {
    const next = window.prompt(t('chat.session.renameTitle'), session.title || '');
    if (next === null) return;
    const title = String(next).trim();
    if (!title) return;
    Promise.resolve(updateSessionInfo(session.id, { title }))
      .then(() => refreshSessions().catch(() => {}))
      .catch(() => Alert.alert(t('app.save.failed.title'), t('app.save.failed.body')));
  };

  const onPin = (session) => {
    Promise.resolve(pinSession(session.id))
      .then(() => refreshSessions().catch(() => {}))
      .catch(() => Alert.alert(t('memory.pin.fail.title'), t('common.error.storageOrPermission')));
  };

  const onClone = (session) => {
    Alert.alert(t('memory.clone.title'), t('memory.clone.body'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('memory.clone.action'),
        onPress: () => {
          Promise.resolve(cloneSession(session.id))
            .then(() => refreshSessions().catch(() => {}))
            .catch(() => Alert.alert(t('memory.clone.fail.title'), t('common.error.storageOrPermission')));
        },
      },
    ]);
  };

  // 删除会话时先查「有没有动态锚定在这段对话上」（手机 MemoryScreen.onDelete 同款）：
  // 直接删会话会留下指向不存在会话的孤儿动态，所以这里给第三选「连带删除」。
  const confirmDeleteOne = session => {
    const doDelete = async deleteMomentsToo => {
      let momentsDeleted = false;
      try {
        if (deleteMomentsToo) {
          await deleteMomentsBySessionIds([session.id]);
          momentsDeleted = true;
        }
        await deleteSession(session.id);
        refreshSessions().catch(() => {});
      } catch (error) {
        Alert.alert(
          t('common.error.deleteFailed'),
          momentsDeleted
            ? t('memory.delete.momentsDeletedFail.body')
            : t('common.error.storageOrPermission')
        );
      }
    };
    getMomentsStatus()
      .then(({ status, moments }) => {
        if (status === 'corrupt') throw new Error(t('memory.moments.readFail'));
        return countMomentsBySessionIds(moments, [session.id]);
      })
      .then(count => {
        if (count === 0) {
          Alert.alert(t('memory.deleteSession.title'), t('memory.deleteSession.body'), [
            { text: t('common.cancel'), style: 'cancel' },
            { text: t('common.delete'), style: 'destructive', onPress: () => { doDelete(false); } },
          ]);
          return;
        }
        Alert.alert(
          t('memory.deleteMemory.title'),
          t('memory.deleteMemory.body', { count }),
          [
            { text: t('common.cancel'), style: 'cancel' },
            { text: t('memory.deleteMemory.onlyMemory'), onPress: () => { doDelete(false); } },
            { text: t('memory.deleteMemory.deleteAll'), style: 'destructive', onPress: () => { doDelete(true); } },
          ]
        );
      })
      .catch(() => {
        Alert.alert(t('common.error.deleteFailed'), t('memory.delete.linkedReadFail.body'));
      });
  };

  const confirmDeleteSelected = () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    const doDelete = async deleteMomentsToo => {
      let momentsDeleted = false;
      try {
        if (deleteMomentsToo) {
          await deleteMomentsBySessionIds(ids);
          momentsDeleted = true;
        }
        await deleteSessions(ids);
        exitEdit();
        refreshSessions().catch(() => {});
      } catch (error) {
        Alert.alert(
          t('common.error.deleteFailed'),
          momentsDeleted
            ? t('memory.delete.momentsDeletedFailBatch.body')
            : t('common.error.storageOrPermission')
        );
      }
    };
    // 批量同理：先统计关联动态数，有就给「连带删除」选项（手机 deleteBatch.bodyLinked 同款）。
    getMomentsStatus()
      .then(({ status, moments }) => {
        if (status === 'corrupt') throw new Error(t('memory.moments.readFail'));
        return countMomentsBySessionIds(moments, ids);
      })
      .then(linked => {
        if (linked === 0) {
          Alert.alert(t('memory.deleteSession.title'), t('memory.deleteBatch.body', { count: ids.length }), [
            { text: t('common.cancel'), style: 'cancel' },
            { text: t('common.delete'), style: 'destructive', onPress: () => { doDelete(false); } },
          ]);
          return;
        }
        Alert.alert(
          t('memory.deleteMemory.title'),
          t('memory.deleteBatch.bodyLinked', { count: ids.length, linked }),
          [
            { text: t('common.cancel'), style: 'cancel' },
            { text: t('memory.deleteMemory.onlyMemory'), onPress: () => { doDelete(false); } },
            { text: t('memory.deleteMemory.deleteAll'), style: 'destructive', onPress: () => { doDelete(true); } },
          ]
        );
      })
      .catch(() => {
        Alert.alert(t('common.error.deleteFailed'), t('memory.delete.linkedReadFail.body'));
      });
  };

  const rowMenu = (session) => {
    const buttons = [
      { text: t('chat.session.rename'), onPress: () => onRename(session) },
      { text: session.pinned ? t('memory.unpin') : t('memory.pin'), onPress: () => onPin(session) },
      { text: t('memory.clone.action'), onPress: () => onClone(session) },
      { text: t('common.delete'), style: 'destructive', onPress: () => confirmDeleteOne(session) },
    ];
    Alert.alert(
      session.title || t('memory.unnamedCharacter'),
      buildPreview([]) || undefined,
      buttons
    );
  };

  return (
    <section style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 20px 6px' }}>
        <strong style={{ fontSize: fonts.scaled(17) }}>{t('memory.title')}</strong>
        <span style={{ color: palette.textFaint, fontSize: fonts.scaled(12) }}>{rows.length}</span>
        <span style={{ flex: 1 }} />
        {loaded && rows.length > 0 ? (
          <button
            type="button"
            style={ghost(palette, fonts, editing ? { background: palette.surfaceAlt } : {})}
            onClick={() => (editing ? exitEdit() : setEditing(true))}
          >
            {editing ? t('common.done') : t('memory.edit')}
          </button>
        ) : null}
        {typeof onCreateGroup === 'function' ? (
          <button type="button" style={ghost(palette, fonts)} onClick={onCreateGroup}>
            {t('character.library.group.createTitle')}
          </button>
        ) : null}
        <button type="button" style={ghost(palette, fonts)} onClick={() => setRecoverOpen(value => !value)}>
          {t('memory.a11y.recover')}
        </button>
        <button type="button" style={ghost(palette, fonts)} onClick={() => setGlobalSearchOpen(true)}>
          {t('search.action.search')}
        </button>
        <button type="button" style={ghost(palette, fonts)} onClick={() => setCheckupOpen(true)}>
          {t('memory.checkup.title')}
        </button>
        <button type="button" style={ghost(palette, fonts)} onClick={() => onTutorial && onTutorial('memory')}>
          {t('memory.a11y.tutorial')}
        </button>
        {/* 展开/折叠全部：手机「记忆页 ⋯」的第三项，桌面此前只有逐组点击。 */}
        <button
          type="button"
          style={ghost(palette, fonts)}
          disabled={groups.length === 0}
          onClick={() => {
            const allOpen = groups.every(group => expanded.has(group.id));
            setExpanded(allOpen ? new Set() : new Set(groups.map(group => group.id)));
          }}
        >
          {groups.length > 0 && groups.every(group => expanded.has(group.id))
            ? t('memory.collapseAll')
            : t('memory.expandAll')}
        </button>
      </div>

      <div style={{ display: 'flex', gap: 6, padding: '0 20px 8px', flexWrap: 'wrap', alignItems: 'center' }}>
        {filters.map(item => {
          const active = filterId === item.id;
          return (
            <button
              key={item.id}
              type="button"
              style={{
                ...ghost(palette, fonts),
                background: active ? palette.primary : 'transparent',
                color: active ? palette.primaryContrast : palette.textMuted,
                border: `1px solid ${active ? palette.primary : palette.divider}`,
              }}
              onClick={() => {
                if (editing) exitEdit();
                setFilterId(item.id);
              }}
            >
              {t(item.labelKey)}
            </button>
          );
        })}
        <span style={{ flex: 1 }} />
        <div style={{ width: 200 }}>
          <input
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder={t('memory.searchPlaceholder')}
            spellCheck={false}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              background: palette.surface,
              color: palette.text,
              border: `1px solid ${palette.divider}`,
              borderRadius: 8,
              padding: '6px 10px',
              fontSize: fonts.scaled(12),
              outline: 'none',
            }}
          />
        </div>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: '0 20px 20px' }}>
        {!loaded ? (
          <div style={{ color: palette.textMuted, fontSize: fonts.scaled(12) }}>…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: '28px 0', color: palette.textMuted, fontSize: fonts.scaled(12) }}>
            {t('memory.empty.title')}
          </div>
        ) : items.map(item => {
          if (item.kind === 'header') {
            const open = expanded.has(item.groupId);
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => toggleExpanded(item.groupId)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  width: '100%',
                  background: 'transparent',
                  border: 'none',
                  color: palette.textMuted,
                  padding: '10px 2px 6px',
                  cursor: 'pointer',
                  fontSize: fonts.scaled(12),
                  fontWeight: 700,
                }}
              >
                <span>{open ? '▾' : '▸'}</span>
                <span>{t(item.labelKey || 'memory.bucket.recent')}</span>
                <span style={{ color: palette.textFaint, fontWeight: 400 }}>{item.count}</span>
              </button>
            );
          }
          const row = item.row;
          if (!row) return null;
          const session = row.session;
          const selected = selectedIds.includes(session.id);
          const preview = String(session.preview || '').trim() || t('memory.emptyPreview');
          return (
            <div
              key={item.id}
              role="button"
              tabIndex={0}
              onClick={() => (editing ? setSelectedIds(current => (
                current.includes(session.id)
                  ? current.filter(id => id !== session.id)
                  : [...current, session.id]
              )) : onOpenSession(session))}
              onContextMenu={event => {
                if (editing) return;
                event.preventDefault();
                rowMenu(session);
              }}
              onKeyDown={event => {
                if (event.key !== 'Enter') return;
                if (editing) setSelectedIds(current => (
                  current.includes(session.id) ? current.filter(id => id !== session.id) : [...current, session.id]
                ));
                else onOpenSession(session);
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '9px 12px',
                marginBottom: 4,
                borderRadius: 10,
                cursor: 'pointer',
                background: editing && selected ? palette.surfaceAlt : palette.surface,
                border: `1px solid ${editing && selected ? palette.primaryMuted : palette.divider}`,
              }}
            >
              {editing ? (
                <input type="checkbox" checked={selected} readOnly style={{ flex: 'none' }} />
              ) : null}
              <span style={{ flex: 'none', fontSize: 12, color: palette.textFaint, width: 14 }}>
                {hasSessionUnread(session) ? '●' : ''}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{
                    fontSize: fonts.scaled(13),
                    fontWeight: 600,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  >
                    {row.displayName || t('memory.unnamedCharacter')}
                    {session.title ? <span style={{ color: palette.textMuted, fontWeight: 400 }}> · {session.title}</span> : null}
                  </span>
                  {buildSessionBadges(session).map(badge => (
                    <span key={badge.labelKey || badge.text} style={{
                      fontSize: fonts.scaled(10),
                      color: palette.textFaint,
                      border: `1px solid ${palette.divider}`,
                      borderRadius: 999,
                      padding: '0 6px',
                      flex: 'none',
                    }}
                    >
                      {t(badge.labelKey || 'memory.emptyPreview')}
                    </span>
                  ))}
                </div>
                <div style={{
                  marginTop: 2,
                  fontSize: fonts.scaled(11),
                  color: palette.textMuted,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                >
                  {preview}
                </div>
              </div>
              <span style={{ flex: 'none', fontSize: fonts.scaled(11), color: palette.textFaint }}>
                {formatTime(session.updatedAt, localeId)}
              </span>
              {!editing ? (
                <div style={{ display: 'flex', gap: 4, flex: 'none' }}>
                  <button
                    type="button"
                    style={ghost(palette, fonts)}
                    title={t('chat.session.rename')}
                    onClick={event => { event.stopPropagation(); onRename(session); }}
                  >
                    ✎
                  </button>
                  <button
                    type="button"
                    style={ghost(palette, fonts)}
                    title={session.pinned ? t('memory.unpin') : t('memory.pin')}
                    onClick={event => { event.stopPropagation(); onPin(session); }}
                  >
                    {session.pinned ? '📌' : '📍'}
                  </button>
                  <button
                    type="button"
                    style={ghost(palette, fonts)}
                    onClick={event => { event.stopPropagation(); rowMenu(session); }}
                  >
                    ⋯
                  </button>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {editing ? (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '10px 20px',
          borderTop: `1px solid ${palette.divider}`,
          flex: 'none',
        }}
        >
          <button
            type="button"
            style={ghost(palette, fonts)}
            onClick={() => setSelectedIds(allSelected ? [] : selectableIds)}
          >
            {allSelected ? t('memory.unselectAll') : t('memory.selectAll')}
          </button>
          <span style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>
            {t('memory.deleteCount', { count: selectedIds.length })}
          </span>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            disabled={selectedIds.length === 0}
            onClick={confirmDeleteSelected}
            style={{
              background: selectedIds.length === 0 ? palette.surfaceAlt : (palette.danger || '#ff5a5f'),
              color: selectedIds.length === 0 ? palette.textMuted : '#fff',
              border: 'none',
              borderRadius: 8,
              padding: '7px 14px',
              fontSize: fonts.scaled(12),
              fontWeight: 700,
              cursor: selectedIds.length === 0 ? 'default' : 'pointer',
            }}
          >
            {t('common.delete')}
          </button>
        </div>
      ) : null}

      {/* 屏幕对话：独立面板（不该绑在孤儿回收的开关下）。 */}
      <ScreenWatchThreadsPanel palette={palette} fonts={fonts} />

      {recoverOpen ? (
        <OrphanRecoveryPanel palette={palette} fonts={fonts} />
      ) : null}
      <GlobalSearchPanel
        open={globalSearchOpen}
        onClose={() => setGlobalSearchOpen(false)}
        palette={palette}
        fonts={fonts}
        onOpenSession={onOpenSession}
      />
      <MemoryCheckupPanel
        open={checkupOpen}
        onClose={() => setCheckupOpen(false)}
        palette={palette}
        fonts={fonts}
        sessions={sessions}
        characters={characters}
      />
    </section>
  );
}