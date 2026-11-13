// 世界地图（桌面）：在网格上给自己和角色安家。
//
// 数据与判定全部复用共享层：
//   · worldMap/map.js —— 40×40 网格、房号分配、每人最多 1 栋、放置/删除/搬迁的
//     不可变更新（placeHouse / removeHouseAtCell / canAssignOwner 等）；
//   · storage/worldMap.js —— getWorldMap / updateWorldMap（读失败就抛错中止，
//     绝不用空地图整键覆盖）。
//
// 与手机的平台差异：手机 MapPanel 用手势拖拽 + 长按菜单；桌面用点击格子 + 表单，
// 因为鼠标没有长按语义。地图本身是同一份 MAP_GRID_SIZE 网格。
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useApp } from '../../../../src/context/AppContext.js';
import { useTranslation } from '../../../../src/i18n/I18nContext.js';
import {
  MAP_GRID_SIZE,
  MAP_OWNER_SELF,
  canAddResident,
  canAssignOwner,
  houseAtCell,
  houseNumberLabel,
  housemateCharacterIds,
  normalizeMapHouses,
  placeHouse,
  removeHouseAtCell,
} from '../../../../src/worldMap/map.js';
import { getWorldMap, updateWorldMap } from '../../../../src/storage/worldMap.js';
import { Alert } from '../../platform/alert.js';
import { Button, Card, Field, Row, Select, TextInput } from '../../settings/ui.jsx';

// 网格显示尺寸：40×40 在 1:1 像素下是 40px/格 = 1600px，桌面窗口放不下，
// 因此每格 16px（共 640px）；点选坐标按 CELL_SIZE 整除得到。
const CELL_SIZE = 16;

export default function MapScreen({ palette, fonts }) {
  const { t } = useTranslation();
  const { characters } = useApp();
  const [houses, setHouses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(null);
  const [draft, setDraft] = useState({ name: '', ownerId: '', residentId: '' });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const map = await getWorldMap();
      setHouses(normalizeMapHouses(map && map.houses));
    } catch (error) {
      // 读失败不伪装成空地图（否则下一次写入会把所有房子抹掉）。
      Alert.alert(t('map.notice.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { load(); }, [load]);

  const characterMap = useMemo(() => {
    const map = new Map();
    (Array.isArray(characters) ? characters : []).forEach(item => {
      if (item && item.id) map.set(item.id, item);
    });
    return map;
  }, [characters]);

  const persist = async next => {
    await updateWorldMap(current => ({ ...current, houses: next }));
    setHouses(normalizeMapHouses(next));
  };

  const pickCell = (x, y) => {
    const existing = houseAtCell(houses, x, y);
    setSelected({ x, y });
    setDraft(existing
      ? {
        name: existing.name || '',
        ownerId: existing.ownerType === 'character' ? existing.ownerId : '',
        residentId: existing.residents[0] || '',
      }
      : { name: '', ownerId: '', residentId: '' });
  };

  const saveHouse = async () => {
    if (!selected || busy) return;
    setBusy(true);
    try {
      const existing = houseAtCell(houses, selected.x, selected.y);
      const owner = draft.ownerId
        ? { type: 'character', id: draft.ownerId }
        : { type: MAP_OWNER_SELF };
      // 「每人最多 1 栋」由共享层判定：冲突时如实拒绝，不静默覆盖别人的房子。
      const check = canAssignOwner(
        houses.filter(item => !existing || item.id !== existing.id),
        owner,
        existing ? existing.id : ''
      );
      if (check && check.ok === false) {
        // canAssignOwner 返回 { ok, conflict }：冲突的那栋房子决定文案（角色房还是自己的房）。
        const conflict = check.conflict || {};
        const label = houseNumberLabel(conflict, houses);
        const name = String((characterMap.get(draft.ownerId) || {}).name || t('map.characterFallback'));
        Alert.alert(
          t('map.alert.transferFailed.title'),
          conflict.ownerType === 'character'
            ? t('map.alert.transferFailed.bodyCharacter', { name, label })
            : t('map.alert.transferFailed.bodySelf', { label })
        );
        return;
      }
      const residents = draft.residentId ? [draft.residentId] : [];
      if (draft.residentId) {
        // canAddResident 返回 { ok, conflict }，conflict 是它当前住的那栋房子。
        const addCheck = canAddResident(houses, draft.residentId, existing ? existing.id : '');
        if (addCheck && addCheck.ok === false) {
          Alert.alert(t('map.alert.moveInFailed.title'), t('map.alert.moveInFailed.body', {
            name: String((characterMap.get(draft.residentId) || {}).name || t('map.characterFallback')),
            label: houseNumberLabel(addCheck.conflict || {}, houses),
          }));
          return;
        }
      }
      const next = placeHouse(houses, {
        ...(existing || { id: '', createdAt: Date.now() }),
        x: selected.x,
        y: selected.y,
        name: draft.name,
        ownerType: owner.type,
        ownerId: owner.type === 'character' ? owner.id : '',
        ownerName: owner.type === 'character'
          ? String((characterMap.get(owner.id) || {}).name || '')
          : '',
        residents,
      });
      await persist(next);
    } catch (error) {
      Alert.alert(t('map.alert.saveFailed.title'), t('map.alert.saveFailed.body'));
    } finally {
      setBusy(false);
    }
  };

  const deleteHouse = () => {
    if (!selected || busy) return;
    const existing = houseAtCell(houses, selected.x, selected.y);
    if (!existing) return;
    Alert.alert(
      t('map.alert.deleteHouse.title'),
      t('map.alert.deleteHouse.body', {
        label: houseNumberLabel(existing, houses),
        x: existing.x,
        y: existing.y,
      }),
      [
        { text: t('map.cancel'), style: 'cancel' },
        {
          text: t('map.delete'),
          style: 'destructive',
          onPress: async () => {
            setBusy(true);
            try {
              await persist(removeHouseAtCell(houses, existing.x, existing.y));
              setSelected(null);
            } catch (error) {
              Alert.alert(t('map.alert.deleteFailed.title'), t('map.alert.deleteFailed.body'));
            } finally {
              setBusy(false);
            }
          },
        },
      ]
    );
  };

  const cellColor = house => {
    if (!house) return 'transparent';
    if (house.ownerType === 'character') return palette.primaryMuted || palette.primary;
    return palette.accent || palette.primary;
  };

  const characterOptions = [
    { value: '', label: t('map.owner.self') },
    ...Array.from(characterMap.values()).map(item => ({
      value: item.id,
      label: item.name || t('common.unnamedCharacter'),
    })),
  ];
  const residentOptions = [
    { value: '', label: t('map.house.noResidents') },
    ...Array.from(characterMap.values()).map(item => ({
      value: item.id,
      label: item.name || t('common.unnamedCharacter'),
    })),
  ];

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 16, minWidth: 0 }}>
      <Card title={t('ext.home.map')} hint={t('ext.home.map.desc')} palette={palette} fonts={fonts}>
        <Row>
          <Button
            label={loading ? t('backup.progress.ratio') : t('ext.home.map.summary', { count: houses.length })}
            onClick={load}
            palette={palette}
            fonts={fonts}
            disabled={loading}
          />
        </Row>
        <div style={{
          width: MAP_GRID_SIZE * CELL_SIZE,
          height: MAP_GRID_SIZE * CELL_SIZE,
          display: 'grid',
          gridTemplateColumns: `repeat(${MAP_GRID_SIZE}, ${CELL_SIZE}px)`,
          gap: 1,
          background: palette.divider,
          border: `1px solid ${palette.divider}`,
          maxWidth: '100%',
          overflow: 'auto',
        }}
        >
          {Array.from({ length: MAP_GRID_SIZE * MAP_GRID_SIZE }, (_, index) => {
            const x = index % MAP_GRID_SIZE;
            const y = Math.floor(index / MAP_GRID_SIZE);
            const house = houseAtCell(houses, x, y);
            const isSelected = selected && selected.x === x && selected.y === y;
            return (
              <button
                key={`${x}-${y}`}
                type="button"
                onClick={() => pickCell(x, y)}
                title={house
                  ? `${houseNumberLabel(house, houses)} · ${house.ownerType === 'character' ? (house.ownerName || t('map.characterFallback')) : t('map.owner.self')}`
                  : `${x},${y}`}
                style={{
                  width: CELL_SIZE,
                  height: CELL_SIZE,
                  padding: 0,
                  border: isSelected ? `2px solid ${palette.text}` : 'none',
                  background: cellColor(house),
                  cursor: 'pointer',
                }}
              />
            );
          })}
        </div>
        <div style={{ fontSize: fonts.scaled(10), color: palette.textFaint, lineHeight: 1.6 }}>
          {t('ext.home.map.desc')}
        </div>
      </Card>

      <Card palette={palette} fonts={fonts} title={t('map.house.self')}>
        {!selected ? (
          <div style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>{t('map.place')}</div>
        ) : (
          <>
            <div style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>
              {selected.x}, {selected.y}
            </div>
            <Field label={t('map.unnamed')} palette={palette} fonts={fonts}>
              <TextInput
                value={draft.name}
                onChange={value => setDraft(current => ({ ...current, name: value }))}
                placeholder={t('map.house.self')}
                palette={palette}
                fonts={fonts}
              />
            </Field>
            <Field label={t('map.owner.set')} palette={palette} fonts={fonts}>
              <Select
                value={draft.ownerId}
                options={characterOptions}
                onChange={value => setDraft(current => ({ ...current, ownerId: value }))}
                palette={palette}
                fonts={fonts}
              />
            </Field>
            <Field label={t('map.house.noResidents')} palette={palette} fonts={fonts}>
              <Select
                value={draft.residentId}
                options={residentOptions}
                onChange={value => setDraft(current => ({ ...current, residentId: value }))}
                palette={palette}
                fonts={fonts}
              />
            </Field>
            <Row>
              <Button
                label={busy ? t('backup.progress.ratio') : t('map.save')}
                onClick={saveHouse}
                palette={palette}
                fonts={fonts}
                primary
                disabled={busy}
              />
              <Button
                label={t('map.delete')}
                onClick={deleteHouse}
                palette={palette}
                fonts={fonts}
                tone={palette.danger || '#ff5a5f'}
                disabled={busy || !houseAtCell(houses, selected.x, selected.y)}
              />
            </Row>
          </>
        )}
      </Card>

      {houses.length > 0 ? (
        <Card palette={palette} fonts={fonts} title={t('map.house.meta', {
          owner: t('map.owner.self'),
          residents: t('map.house.noResidents'),
        })}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {houses.map(house => {
              const residents = housemateCharacterIds(houses, house.residents[0] || '')
                .map(id => String((characterMap.get(id) || {}).name || ''))
                .filter(Boolean);
              return (
                <div key={house.id} style={{ fontSize: fonts.scaled(11), color: palette.textMuted, lineHeight: 1.6 }}>
                  <strong style={{ color: palette.text }}>{houseNumberLabel(house, houses)}</strong>
                  {' · '}
                  {t('map.house.meta', {
                    owner: house.ownerType === 'character'
                      ? String(house.ownerName || t('map.characterFallback'))
                      : t('map.owner.self'),
                    residents: residents.length > 0 ? residents.join(t('character.library.group.nameJoin')) : t('map.house.noResidents'),
                  })}
                </div>
              );
            })}
          </div>
        </Card>
      ) : null}
    </div>
  );
}