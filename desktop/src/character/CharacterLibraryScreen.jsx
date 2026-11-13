// 角色库（桌面）：多角色网格 + 新建 / 搜索 / 置顶 / 编辑 / 导入 / 导出 / 删除。
//
// 数据与动作全部来自 AppContext 与 backup/services.js（与 Android 角色库同一套存储），
// 本文件只决定「桌面版怎么摆」。列表派生（搜索/置顶排序/摘要）在 libraryView.js（可直测）。
// 删除沿用共享层的顺序纪律：先删角色（可重试），成功后才清会话；默认角色不可删。
import { useMemo, useState } from 'react';

import { useTranslation } from '../../../src/i18n/I18nContext.js';
import { Alert } from '../platform/alert.js';
import { mediaUrl } from '../platform/mediaUrl.js';
import { characterSummary, filterCharacters, sortCharacters } from './libraryView.js';
import { exportCharacterCard } from '../backup/services.js';

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
  onPin,
  onImport,
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
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

  const confirmDelete = character => {
    if (character.id === 'default') return;
    Alert.alert(
      t('character.library.delete.title'),
      t('character.library.delete.introSingle', { name: character.name || character.id }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('common.delete'), style: 'destructive', onPress: () => onDelete(character.id) },
      ]
    );
  };

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
    </section>
  );
}