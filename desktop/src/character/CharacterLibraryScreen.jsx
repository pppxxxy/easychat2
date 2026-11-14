// 角色库（桌面）：多角色网格 + 新建 / 搜索 / 置顶 / 编辑 / 导入 / 导出 / 删除。
//
// 数据与动作全部来自 AppContext 与 backup/services.js（与 Android 角色库同一套存储），
// 本文件只决定「桌面版怎么摆」。列表派生（搜索/置顶排序/摘要）在 libraryView.js（可直测）。
// 删除沿用共享层的顺序纪律：先删角色（可重试），成功后才清会话；默认角色不可删。
import { useEffect, useMemo, useState } from 'react';

import { useTranslation } from '../../../src/i18n/I18nContext.js';
import { Alert } from '../platform/alert.js';
import { mediaUrl } from '../platform/mediaUrl.js';
import { characterSummary, filterCharacters, sortCharacters } from './libraryView.js';
// 多选判据与「是否删光整库」都用共享实现（手机 CharacterLibraryScreen 同源）。
import { selectableCharacterIds, shouldDeleteEverything } from '../../../src/character/characterLibraryDelete.js';
import { exportCharacterCard } from '../backup/services.js';
import CharacterShareDialog from './CharacterShareDialog.jsx';

function Avatar({ uri, name, palette, fonts, size = 56 }) {
  const src = useMemo(() => (uri ? mediaUrl(uri) : null), [uri]);
  if (src) {
    return (
      <img
        src={src}
        alt=""
        style={{ width: size, height: size, borderRadius: size / 2, objectFit: 'cover', flex: 'none' }}
      />
    );
  }
  return (
    <div style={{
      width: size,
      height: size,
      borderRadius: size / 2,
      flex: 'none',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: palette.surfaceAlt,
      color: palette.textMuted,
      fontSize: fonts.scaled(20),
      fontWeight: 700,
    }}
    >
      {String(name || '?').slice(0, 1).toUpperCase()}
    </div>
  );
}

export default function CharacterLibraryScreen({
  characters,
  activeId,
  palette,
  fonts,
  busy,
  onOpen,
  onCreate,
  onEdit,
  onDelete,
  onCollectDeleteImpact = null,
  onPin,
  onImport,
  onImportShareCode,
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  // 多选态：与手机同一套判据（可删 id、全选、删光整库升级重确认）。
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState([]);
  const visible = useMemo(
    () => sortCharacters(filterCharacters(characters, query)),
    [characters, query]
  );

  const ghost = {
    background: 'transparent',
    color: palette.textMuted,
    border: `1px solid ${palette.divider}`,
    borderRadius: 8,
    padding: '4px 9px',
    cursor: busy ? 'default' : 'pointer',
    fontSize: fonts.scaled(11),
  };

  // 只允许勾选「筛选后可见且可删」的角色：默认角色不可删，筛选外的不该被全选带走。
  const selectableIds = useMemo(() => selectableCharacterIds(visible), [visible]);
  const allSelected = selectableIds.length > 0 && selectableIds.every(id => selectedIds.includes(id));
  useEffect(() => {
    // 筛选变化后把已不可见的勾选去掉，避免「看着选了 3 个实际删了 5 个」。
    setSelectedIds(current => current.filter(id => selectableIds.includes(id)));
  }, [selectableIds]);

  const toggleSelect = id => {
    setSelectedIds(current => (
      current.includes(id) ? current.filter(item => item !== id) : [...current, id]
    ));
  };

  // 批量删除：确认门与手机一致——只有真要删光整库才升级成「删除全部」重确认。
  const deleteSelected = async () => {
    if (selectedIds.length === 0) return;
    const ids = selectedIds.slice();
    if (shouldDeleteEverything(ids, characters)) {
      Alert.alert(
        t('character.library.deleteAll.title'),
        t('character.library.deleteAll.body'),
        [
          { text: t('common.cancel'), style: 'cancel' },
          {
            text: t('character.library.deleteAll.confirm'),
            style: 'destructive',
            onPress: () => confirmBatch(ids),
          },
        ]
      );
      return;
    }
    Alert.alert(
      t('character.library.delete.title'),
      t('character.library.delete.introBatch', { count: ids.length }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('character.library.delete.continue'),
          style: 'destructive',
          onPress: () => confirmBatch(ids),
        },
      ]
    );
  };

  // 第二批确认：有关联数据时给出「只删角色 / 连记忆一起删」（与单个删除同一口径）。
  const confirmBatch = async ids => {
    let impact = null;
    try {
      impact = await onCollectDeleteImpact(ids);
    } catch (error) {
      Alert.alert(t('common.error.deleteFailed'), t('common.error.storageOrPermission'));
      return;
    }
    const details = [];
    if (impact && impact.sessionIds.length > 0) {
      details.push(t('character.library.delete.detail.memories', { count: impact.sessionIds.length }));
    }
    if (impact && impact.linkedMoments > 0) {
      details.push(t('character.library.delete.detail.moments', { count: impact.linkedMoments }));
    }
    const run = deleteMemories => {
      // 逐个走同一条删除编排（onDelete 内部已含 fail-closed 的连带清理）。
      ids.forEach(id => onDelete(id, { deleteMemories }));
      setSelectedIds([]);
      setSelecting(false);
    };
    if (details.length === 0) {
      run(false);
      return;
    }
    Alert.alert(
      t('character.library.delete.title'),
      t('character.library.delete.withLinked', {
        intro: t('character.library.delete.introBatch', { count: ids.length }),
        details: details.join(t('character.library.delete.detail.join')),
      }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('character.library.delete.onlyCharacter'), onPress: () => run(false) },
        { text: t('common.delete'), style: 'destructive', onPress: () => run(true) },
      ]
    );
  };

  // 删除角色：先统计关联数据（会话/动态），有就给出「只删角色 / 连记忆一起删」两选。
  // 手机 CharacterLibraryScreen.showDeleteChoice 同一口径——否则用户以为删干净了，
  // 记忆页里还躺着一堆指向已删角色的对话。
  const confirmDelete = async character => {
    if (character.id === 'default') return;
    let impact = null;
    try {
      impact = await onCollectDeleteImpact([character.id]);
    } catch (error) {
      Alert.alert(t('common.error.deleteFailed'), t('common.error.storageOrPermission'));
      return;
    }
    if (!impact || (impact.sessionIds.length === 0 && impact.linkedMoments === 0)) {
      Alert.alert(
        t('character.library.delete.title'),
        t('character.library.delete.introSingle', { name: character.name || character.id }),
        [
          { text: t('common.cancel'), style: 'cancel' },
          {
            text: t('common.delete'),
            style: 'destructive',
            onPress: () => onDelete(character.id, { deleteMemories: false }),
          },
        ]
      );
      return;
    }
    const details = [];
    if (impact.sessionIds.length > 0) {
      details.push(t('character.library.delete.detail.memories', { count: impact.sessionIds.length }));
    }
    if (impact.linkedMoments > 0) {
      details.push(t('character.library.delete.detail.moments', { count: impact.linkedMoments }));
    }
    Alert.alert(
      t('character.library.delete.title'),
      t('character.library.delete.withLinked', {
        intro: t('character.library.delete.introSingle', { name: character.name || character.id }),
        details: details.join(t('character.library.delete.detail.join')),
      }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('character.library.delete.onlyCharacter'),
          onPress: () => onDelete(character.id, { deleteMemories: false }),
        },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: () => onDelete(character.id, { deleteMemories: true }),
        },
      ]
    );
  };

  // 分享面板（分享码/二维码/从剪贴板导入）：与导出对话框同样的入口密度。
  const [shareTarget, setShareTarget] = useState(null);

  const exportCard = character => {
    Alert.alert(t('character.detail.export.dialogTitle'), t('character.detail.export.body'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('character.detail.export.png'), onPress: () => runExport(character, 'png') },
      { text: t('character.detail.export.json'), onPress: () => runExport(character, 'json') },
    ]);
  };

  const runExport = async (character, format) => {
    try {
      const result = await exportCharacterCard(character, format);
      if (!result.canceled) {
        Alert.alert(
          t('character.detail.export.doneTitle'),
          t('character.detail.export.doneBody', { uri: result.path })
        );
      }
    } catch (error) {
      Alert.alert(
        t('character.detail.export.failTitle'),
        String((error && error.message) || t('common.error.retryLater'))
      );
    }
  };

  return (
    <section style={{ flex: 1, overflow: 'auto', padding: 20, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <strong style={{ fontSize: fonts.scaled(17) }}>{t('character.library.cardTitle')}</strong>
        <span style={{ color: palette.textFaint, fontSize: fonts.scaled(12) }}>
          {visible.length} / {characters.length}
        </span>
        <span style={{ flex: 1 }} />
        <div style={{ width: 220 }}>
          <input
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder={t('character.library.searchPlaceholder')}
            spellCheck={false}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              background: palette.surface,
              color: palette.text,
              border: `1px solid ${palette.divider}`,
              borderRadius: 8,
              padding: '7px 10px',
              fontSize: fonts.scaled(12),
              outline: 'none',
            }}
          />
        </div>
        <button
          type="button"
          style={ghost}
          disabled={!!busy}
          onClick={() => {
            setSelecting(current => {
              if (current) setSelectedIds([]);
              return !current;
            });
          }}
        >
          {selecting ? t('common.cancel') : t('character.library.select')}
        </button>
        <button type="button" style={ghost} disabled={!!busy} onClick={onImport}>
          {t('backup.card.import')}
        </button>
        <button
          type="button"
          disabled={!!busy}
          onClick={onCreate}
          style={{
            background: palette.primary,
            color: palette.primaryContrast,
            border: 'none',
            borderRadius: 8,
            padding: '7px 14px',
            fontWeight: 700,
            fontSize: fonts.scaled(12),
            cursor: busy ? 'default' : 'pointer',
          }}
        >
          + {t('character.library.new')}
        </button>
      </div>
      <div style={{ color: palette.textMuted, fontSize: fonts.scaled(11), marginBottom: 14 }}>
        {t('character.library.pageHint')}
      </div>
      {selecting ? (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
          padding: '8px 0',
          borderBottom: `1px solid ${palette.divider}`,
          marginBottom: 10,
        }}
        >
          <button type="button" style={ghost} onClick={() => setSelectedIds(allSelected ? [] : selectableIds.slice())}>
            {allSelected ? t('settings.security.bulk.clearAll') : t('settings.security.bulk.selectAll')}
          </button>
          <span style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>
            {t('character.library.selectedCount', { count: selectedIds.length })}
          </span>
          <button
            type="button"
            onClick={deleteSelected}
            disabled={selectedIds.length === 0}
            style={{
              background: selectedIds.length === 0 ? 'transparent' : (palette.danger || '#ff5a5f'),
              color: selectedIds.length === 0 ? palette.textFaint : '#fff',
              border: `1px solid ${selectedIds.length === 0 ? palette.divider : (palette.danger || '#ff5a5f')}`,
              borderRadius: 8,
              padding: '4px 12px',
              fontSize: fonts.scaled(11),
              cursor: selectedIds.length === 0 ? 'default' : 'pointer',
            }}
          >
            {t('common.delete')}
          </button>
        </div>
      ) : null}

      {visible.length === 0 ? (
        <div style={{ color: palette.textMuted, fontSize: fonts.scaled(12), padding: '18px 0' }}>
          {t('character.library.searchEmpty')}
        </div>
      ) : (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
          gap: 12,
        }}
        >
          {visible.map(character => {
            const isActive = character.id === activeId;
            return (
              <div
                key={character.id}
                style={{
                  border: `1px solid ${isActive ? palette.primaryMuted : palette.divider}`,
                  background: palette.surface,
                  borderRadius: 12,
                  padding: 14,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                }}
              >
                <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                  {/* 多选态：勾选框在最左；默认角色不可删，所以不给勾选框（与共享
                      selectableCharacterIds 的判据一致）。 */}
                  {selecting && selectableIds.includes(character.id) ? (
                    <input
                      type="checkbox"
                      checked={selectedIds.includes(character.id)}
                      onChange={() => toggleSelect(character.id)}
                      aria-label={character.name || t('character.detail.unnamed')}
                      style={{ marginTop: 6, flex: 'none' }}
                    />
                  ) : null}
                  <Avatar uri={character.avatarUri} name={character.name} palette={palette} fonts={fonts} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <strong style={{
                        fontSize: fonts.scaled(14),
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      >
                        {character.name || t('character.detail.unnamed')}
                      </strong>
                      {character.pinned ? <span title={t('character.library.a11y.pinCharacter')}>📌</span> : null}
                    </div>
                    <div style={{
                      marginTop: 3,
                      fontSize: fonts.scaled(11),
                      color: palette.textMuted,
                      lineHeight: 1.5,
                      display: '-webkit-box',
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: 'vertical',
                      overflow: 'hidden',
                    }}
                    >
                      {characterSummary(character) || t('character.detail.notSet')}
                    </div>
                  </div>
                </div>
                {Array.isArray(character.tags) && character.tags.length > 0 ? (
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {character.tags.slice(0, 4).map(tag => (
                      <span key={tag} style={{
                        fontSize: fonts.scaled(10),
                        color: palette.textFaint,
                        border: `1px solid ${palette.divider}`,
                        borderRadius: 999,
                        padding: '1px 7px',
                      }}
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                ) : null}
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    style={{ ...ghost, ...(isActive ? {} : { borderColor: palette.primaryMuted, color: palette.text }) }}
                    disabled={!!busy}
                    onClick={() => onOpen(character.id)}
                  >
                    {isActive
                      ? t('character.library.currentLabel', { name: character.name || '' })
                      : t('character.library.a11y.switchCharacter', { name: character.name || '' })}
                  </button>
                  <button type="button" style={ghost} disabled={!!busy} onClick={() => onEdit(character.id)}>
                    {t('character.edit.title')}
                  </button>
                  <button
                    type="button"
                    style={ghost}
                    disabled={!!busy}
                    title={character.pinned ? t('character.library.a11y.unpinCharacter') : t('character.library.a11y.pinCharacter')}
                    onClick={() => onPin(character.id, !character.pinned)}
                  >
                    {character.pinned ? '📌' : '📍'}
                  </button>
                  <button type="button" style={ghost} disabled={!!busy} onClick={() => exportCard(character)}>
                    {t('backup.card.exportJson')}
                  </button>
                  <button type="button" style={ghost} disabled={!!busy} onClick={() => setShareTarget(character)}>
                    {t('character.share.entry')}
                  </button>
                  {character.id !== 'default' ? (
                    <button type="button" style={ghost} disabled={!!busy} onClick={() => confirmDelete(character)}>
                      {t('common.delete')}
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {shareTarget ? (
        <CharacterShareDialog
          character={shareTarget}
          palette={palette}
          fonts={fonts}
          onClose={() => setShareTarget(null)}
          onImportCard={onImportShareCode}
        />
      ) : null}
    </section>
  );
}