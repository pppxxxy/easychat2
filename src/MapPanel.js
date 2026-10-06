import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { getWorldMap, updateWorldMap } from './storage.js';
import {
  assignHouseNumbers,
  canAddResident,
  canAssignOwner,
  cellFromPoint,
  describeHouseOwner,
  houseAtCell,
  houseNumberLabel,
  houseResidentNames,
  makeMapHouseId,
  MAP_GRID_SIZE,
  MAP_OWNER_SELF,
  placeHouse,
  removeHouseAtCell,
} from './worldMap/map.js';
import { useNavigation } from '@react-navigation/native';
import { useApp } from './context/AppContext.js';
import PaneHeader from './ui/PaneHeader.js';
import { FieldGroup, PrimaryButton, SecondaryButton, TextField, CollapsibleSelect } from './ui/index.js';
import { useTheme } from './theme/ThemeContext.js';
import { useTranslation } from './i18n/I18nContext.js';
import RealMapView from './worldMap/RealMapView.js';

const CELL_SIZE = 26;

// 世界地图：40×40 网格，用户可在任意格子放置房子（自己或角色的）。
// 规则：每人最多拥有 1 栋房子（自己的固定编号 000，其余按 001、002… 编号）；
// 每个角色最多住 1 栋房子（可同时拥有自己的一栋并住在别人家）。
// 点格子弹面板编辑；「查看」展开房子列表，点房子可看/改房主与住户。数据存本地。
// Stack 化后面板自带纵向滚动容器。
export default function MapPanel() {
  const navigation = useNavigation();
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const { characters } = useApp();
  const { t } = useTranslation();

  const [mapMode, setMapMode] = useState('grid');
  const [loading, setLoading] = useState(true);
  const [houses, setHouses] = useState([]);
  const [notice, setNotice] = useState('');
  // 编辑中的格子：{ x, y, house }，house 为空表示新建
  const [editing, setEditing] = useState(null);
  const [draftName, setDraftName] = useState('');
  const [draftOwner, setDraftOwner] = useState({ type: MAP_OWNER_SELF, id: '', name: '' });
  const [draftResidents, setDraftResidents] = useState([]);
  const [saving, setSaving] = useState(false);
  // 「查看」房子列表是否展开
  const [listOpen, setListOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await getWorldMap();
      setHouses(list);
    } catch (error) {
      setNotice(t('map.notice.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    load().catch(() => {});
  }, [load]);

  const houseLookup = useMemo(() => {
    const map = new Map();
    houses.forEach(house => map.set(`${house.x}:${house.y}`, house));
    return map;
  }, [houses]);

  // 编号后的房子列表：000 是自己，其余按放置顺序 001、002…
  const numberedHouses = useMemo(() => assignHouseNumbers(houses), [houses]);
  const numberLookup = useMemo(() => {
    const map = new Map();
    numberedHouses.forEach(item => map.set(item.house.id, item.label));
    return map;
  }, [numberedHouses]);

  const selfCount = houses.filter(house => house.ownerType === MAP_OWNER_SELF).length;
  const roleCount = houses.length - selfCount;

  const openCell = useCallback((x, y) => {
    const house = houseAtCell(houses, x, y);
    setDraftName(house ? house.name : '');
    setDraftOwner(house && house.ownerType === 'character'
      ? { type: 'character', id: house.ownerId, name: house.ownerName }
      : { type: MAP_OWNER_SELF, id: '', name: '' });
    setDraftResidents(house && Array.isArray(house.residents) ? house.residents : []);
    setEditing({ x, y, house });
  }, [houses]);

  // 从「查看」列表点某栋房子：没有真实坐标归属，沿用该房子所在格。
  const openHouse = useCallback(house => {
    if (!house) return;
    setListOpen(false);
    openCell(house.x, house.y);
  }, [openCell]);

  // 整块网格只用这一个点击处理器：按触点相对网格的原点换算行列。
  const onGridPress = useCallback(event => {
    const { locationX, locationY } = event.nativeEvent || {};
    const cell = cellFromPoint(locationX, locationY, CELL_SIZE, MAP_GRID_SIZE);
    if (!cell) return;
    openCell(cell.x, cell.y);
  }, [openCell]);

  const closeEditor = useCallback(() => {
    setEditing(null);
  }, []);

  const chooseOwnerSelf = useCallback(() => {
    setDraftOwner({ type: MAP_OWNER_SELF, id: '', name: '' });
  }, []);

  const chooseOwnerCharacter = useCallback(character => {
    setDraftOwner({ type: 'character', id: character.id, name: character.name || t('map.characterFallback') });
  }, [t]);

  const toggleResident = useCallback((character, houseId) => {
    setDraftResidents(current => {
      if (current.includes(character.id)) {
        return current.filter(item => item !== character.id);
      }
      // 一个角色最多住 1 栋：已在别家住则提示其现有房号。
      const check = canAddResident(houses, character.id, houseId);
      if (!check.ok) {
        const label = houseNumberLabel(check.conflict, houses);
        Alert.alert(t('map.alert.moveInFailed.title'), t('map.alert.moveInFailed.body', {
          name: character.name || t('map.theCharacter'),
          label: label || t('map.otherHouse'),
        }));
        return current;
      }
      return [...current, character.id];
    });
  }, [houses, t]);

  const persist = useCallback(async list => {
    const saved = await updateWorldMap(() => list);
    setHouses(saved);
    return saved;
  }, []);

  const saveHouse = useCallback(async () => {
    if (!editing) return;
    const houseId = editing.house ? editing.house.id : '';
    // 每人最多拥有 1 栋：若目标屋主已拥有别的房子则阻止。
    const ownerCheck = canAssignOwner(houses, draftOwner, houseId);
    if (!ownerCheck.ok) {
      const label = houseNumberLabel(ownerCheck.conflict, houses);
      Alert.alert(
        t('map.alert.transferFailed.title'),
        draftOwner.type === 'character'
          ? t('map.alert.transferFailed.bodyCharacter', {
            name: draftOwner.name || t('map.theCharacter'),
            label: label || t('map.anotherHouse'),
          })
          : t('map.alert.transferFailed.bodySelf', { label: label || t('map.anotherHouse') })
      );
      return;
    }
    setSaving(true);
    try {
      const house = {
        id: houseId || makeMapHouseId(),
        x: editing.x,
        y: editing.y,
        name: draftName,
        ownerType: draftOwner.type,
        ownerId: draftOwner.type === 'character' ? draftOwner.id : '',
        ownerName: draftOwner.type === 'character' ? draftOwner.name : '',
        residents: draftResidents,
        createdAt: editing.house ? editing.house.createdAt : Date.now(),
      };
      // placeHouse 会把本房住户从其它房子移除，保证「最多住 1 栋」。
      await persist(placeHouse(houses, house));
      closeEditor();
    } catch (error) {
      Alert.alert(t('map.alert.saveFailed.title'), t('map.alert.saveFailed.body'));
    } finally {
      setSaving(false);
    }
  }, [closeEditor, draftName, draftOwner, draftResidents, editing, houses, persist, t]);

  const deleteHouse = useCallback(async () => {
    if (!editing || !editing.house) return;
    setSaving(true);
    try {
      await persist(removeHouseAtCell(houses, editing.x, editing.y));
      closeEditor();
    } catch (error) {
      Alert.alert(t('map.alert.deleteFailed.title'), t('map.alert.deleteFailed.body'));
    } finally {
      setSaving(false);
    }
  }, [closeEditor, editing, houses, persist, t]);

  const confirmDeleteHouse = useCallback(() => {
    if (!editing || !editing.house) return;
    const label = numberLookup.get(editing.house.id) || '';
    Alert.alert(t('map.alert.deleteHouse.title'), t('map.alert.deleteHouse.body', { label: label ? `${label} ` : '', x: editing.x, y: editing.y }), [
      { text: t('map.cancel'), style: 'cancel' },
      { text: t('map.delete'), style: 'destructive', onPress: () => { deleteHouse(); } },
    ]);
  }, [deleteHouse, editing, numberLookup, t]);

  const editingLabel = editing && editing.house ? numberLookup.get(editing.house.id) : '';

  // 传给 worldMap/map.js 纯函数的展示文案（默认值是中文基准，这里按当前语言覆盖）。
  const mapStrings = useMemo(() => ({
    selfHouse: t('map.house.self'),
    characterFallback: t('map.characterFallback'),
    ownedBy: t('map.house.ownedBy'),
    unnamed: t('map.unnamed'),
    deletedCharacter: t('map.deletedCharacter'),
  }), [t]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={theme.colors.primary} />
      </View>
    );
  }

  const ownerOptions = [
    { value: MAP_OWNER_SELF, label: t('map.owner.self'), meta: t('map.owner.selfMeta') },
    ...characters.map(item => ({
      value: item.id,
      label: item.name || t('map.unnamed'),
      meta: item.id === draftOwner.id ? t('map.owner.current') : t('map.owner.set'),
    })),
  ];
  const ownerValue = draftOwner.type === 'character' ? draftOwner.id : MAP_OWNER_SELF;
  const ownerValueLabel = draftOwner.type === 'character'
    ? (draftOwner.name || t('map.characterFallback'))
    : t('map.owner.self');

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <PaneHeader
        title={t('map.title')}
        onBack={() => navigation.goBack()}
        right={mapMode === 'grid' ? (
          <TouchableOpacity
            style={styles.viewButton}
            onPress={() => setListOpen(v => !v)}
            activeOpacity={0.85}
            accessibilityRole="button"
          >
            <Ionicons name="list-outline" size={15} color={theme.colors.primarySoft} />
            <Text style={styles.viewButtonText}>{listOpen ? t('map.list.collapse') : t('map.list.expand')}</Text>
          </TouchableOpacity>
        ) : null}
      />
      <View style={styles.modeRow}>
        <TouchableOpacity
          style={[styles.modeTab, mapMode === 'grid' && styles.modeTabActive]}
          onPress={() => setMapMode('grid')}
          activeOpacity={0.85}
        >
          <Text style={[styles.modeTabText, mapMode === 'grid' && styles.modeTabTextActive]}>
            {t('world.map.tab.grid')}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.modeTab, mapMode === 'real' && styles.modeTabActive]}
          onPress={() => setMapMode('real')}
          activeOpacity={0.85}
        >
          <Text style={[styles.modeTabText, mapMode === 'real' && styles.modeTabTextActive]}>
            {t('world.map.tab.real')}
          </Text>
        </TouchableOpacity>
      </View>

      {mapMode === 'real' ? <RealMapView /> : (
        <>
          <Text style={styles.hint}>
            {t('map.hint', { size: MAP_GRID_SIZE })}
          </Text>
          <Text style={styles.legend}>
            {t('map.legend', { total: houses.length, self: selfCount, role: roleCount })}
          </Text>

          {listOpen ? (
            <View style={styles.houseList}>
              {numberedHouses.length === 0 ? (
                <Text style={styles.hint}>{t('map.list.empty')}</Text>
              ) : (
                numberedHouses.map(({ house, label }) => (
                  <TouchableOpacity
                    key={house.id}
                    style={styles.houseRow}
                    onPress={() => openHouse(house)}
                    activeOpacity={0.85}
                  >
                    <View style={styles.houseNumberBadge}>
                      <Text style={styles.houseNumberText}>{label}</Text>
                    </View>
                    <View style={styles.houseInfo}>
                      <Text style={styles.houseOwner} numberOfLines={1}>
                        {house.name || describeHouseOwner(house, characters, mapStrings)}
                      </Text>
                      <Text style={styles.houseMeta} numberOfLines={1}>
                        {t('map.house.meta', {
                          owner: describeHouseOwner(house, characters, mapStrings),
                          residents: houseResidentNames(house, characters, mapStrings).join('、') || t('map.house.noResidents'),
                        })}
                      </Text>
                    </View>
                    <Ionicons name="chevron-forward" size={16} color={theme.colors.textFaint} />
                  </TouchableOpacity>
                ))
              )}
            </View>
          ) : null}

          <ScrollView
            horizontal
            style={styles.gridScroll}
            contentContainerStyle={styles.gridScrollContent}
            showsHorizontalScrollIndicator
          >
            {/* 用一整块 Pressable 承接点击、按触点坐标换算格子：避免在 40×40 网格里
                渲染 1600 个 TouchableOpacity，低端机上会明显掉帧。
                内层整体 pointerEvents="none"：否则触摸目标会落到某个单元格上，
                locationX/locationY 变成相对小格（恒为个位数），换算出来永远是左上角。 */}
            <Pressable
              onPress={onGridPress}
              style={styles.grid}
              accessibilityLabel={t('map.grid.a11y')}
            >
              <View pointerEvents="none">
                {Array.from({ length: MAP_GRID_SIZE }).map((_, y) => (
                  <View key={y} style={styles.gridRow}>
                    {Array.from({ length: MAP_GRID_SIZE }).map((_, x) => {
                      const house = houseLookup.get(`${x}:${y}`) || null;
                      const isRoleHouse = !!house && house.ownerType === 'character';
                      return (
                        <View
                          key={x}
                          style={[
                            styles.cell,
                            house && styles.cellHouse,
                            house && (isRoleHouse ? styles.cellRole : styles.cellSelf),
                          ]}
                        >
                          {house ? (
                            <Ionicons
                              name="home"
                              size={12}
                              color={isRoleHouse ? theme.colors.star : theme.colors.primaryContrast}
                            />
                          ) : null}
                        </View>
                      );
                    })}
                  </View>
                ))}
              </View>
            </Pressable>
          </ScrollView>
        </>
      )}

      {notice ? <Text style={styles.notice}>{notice}</Text> : null}

      <Modal
        visible={!!editing}
        transparent
        animationType="fade"
        onRequestClose={closeEditor}
      >
        <View style={styles.overlay}>
          <View style={styles.editor}>
            <Text style={styles.editorTitle}>
              {editing && editing.house
                ? t('map.editor.titleEdit', { label: editingLabel ? `${editingLabel} ` : '', x: editing.x, y: editing.y })
                : t('map.editor.titleNew', { x: editing ? editing.x : '', y: editing ? editing.y : '' })}
            </Text>
            <ScrollView keyboardShouldPersistTaps="handled" style={styles.editorScroll}>
              <FieldGroup label={t('map.editor.nameLabel')} hint={t('map.editor.nameHint')}>
                <TextField
                  value={draftName}
                  onChangeText={setDraftName}
                  placeholder={t('map.editor.namePlaceholder')}
                />
              </FieldGroup>

              <FieldGroup label={t('map.editor.ownerLabel')} hint={t('map.editor.ownerHint')}>
                <CollapsibleSelect
                  value={ownerValue}
                  valueLabel={ownerValueLabel}
                  options={ownerOptions}
                  onSelect={value => {
                    if (value === MAP_OWNER_SELF) {
                      chooseOwnerSelf();
                    } else {
                      const character = characters.find(item => item.id === value);
                      if (character) chooseOwnerCharacter(character);
                    }
                  }}
                  placeholder={t('map.editor.ownerPlaceholder')}
                />
              </FieldGroup>

              <FieldGroup label={t('map.editor.residentsLabel')} hint={t('map.editor.residentsHint')}>
                {characters.length === 0 ? (
                  <Text style={styles.hint}>{t('map.editor.noCharacters')}</Text>
                ) : (
                  <CollapsibleSelect
                    value=""
                    valueLabel={t('map.editor.residentsSelected', { n: draftResidents.length })}
                    placeholder={t('map.editor.residentsPlaceholder')}
                    options={[
                      ...draftResidents
                        .map(id => characters.find(item => item.id === id))
                        .filter(Boolean)
                        .map(item => ({ value: `remove:${item.id}`, label: t('map.editor.removeResident', { name: item.name || t('map.unnamed') }) })),
                      ...characters
                        .filter(item => !draftResidents.includes(item.id))
                        .map(item => ({ value: `add:${item.id}`, label: t('map.editor.addResident', { name: item.name || t('map.unnamed') }) })),
                    ]}
                    emptyHint={t('map.editor.noMoreCharacters')}
                    onSelect={value => {
                      const isRemove = value.startsWith('remove:');
                      const id = value.slice(value.indexOf(':') + 1);
                      const character = characters.find(item => item.id === id);
                      if (!character) return;
                      if (isRemove) {
                        setDraftResidents(current => current.filter(item => item !== id));
                      } else {
                        toggleResident(character, editing && editing.house ? editing.house.id : '');
                      }
                    }}
                  />
                )}
              </FieldGroup>

              {editing && editing.house ? (
                <Text style={styles.editorMeta}>
                  {t('map.editor.currentResidents', { names: houseResidentNames(editing.house, characters, mapStrings).join('、') || t('map.house.noResidents') })}
                </Text>
              ) : null}
            </ScrollView>

            <View style={styles.editorActions}>
              <SecondaryButton title={t('map.cancel')} onPress={closeEditor} style={styles.editorButton} />
              {editing && editing.house ? (
                <SecondaryButton title={t('map.delete')} onPress={confirmDeleteHouse} disabled={saving} style={styles.editorButton} />
              ) : null}
              <PrimaryButton
                title={editing && editing.house ? t('map.save') : t('map.place')}
                onPress={saveHouse}
                disabled={saving}
                style={styles.editorButton}
              />
            </View>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: 200 },
  content: { paddingHorizontal: 20, paddingBottom: 40 },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 6 },
  title: { color: theme.colors.text, fontSize: fonts.scaled(18), fontWeight: '800' },
  viewButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.primaryAlpha(0.12),
    borderWidth: 1,
    borderColor: theme.colors.primaryMutedAlpha(0.45),
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 14,
  },
  viewButtonText: { color: theme.colors.primarySoft, fontSize: fonts.scaled(12), fontWeight: '700', marginLeft: 4 },
  modeRow: { flexDirection: 'row', alignItems: 'center', marginTop: 10 },
  modeTab: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 14,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    marginRight: 8,
  },
  modeTabActive: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  modeTabText: { color: theme.colors.textMuted, fontSize: fonts.scaled(12), fontWeight: '700' },
  modeTabTextActive: { color: theme.colors.primaryContrast },
  hint: { color: theme.colors.textFaint, fontSize: fonts.scaled(12), lineHeight: fonts.scaled(18), marginTop: 8 },
  legend: { color: theme.colors.primaryMuted, fontSize: fonts.scaled(12), fontWeight: '700', marginTop: 10 },
  houseList: { marginTop: 10 },
  houseRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: tokens.radius.md,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    paddingVertical: tokens.spacing.sm,
    paddingHorizontal: tokens.spacing.md,
    marginBottom: tokens.spacing.sm,
  },
  houseNumberBadge: {
    minWidth: 40,
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: tokens.radius.sm,
    backgroundColor: theme.colors.primary,
    alignItems: 'center',
    marginRight: 10,
  },
  houseNumberText: { color: theme.colors.primaryContrast, fontSize: fonts.scaled(13), fontWeight: '800' },
  houseInfo: { flex: 1, marginRight: 8 },
  houseOwner: { color: theme.colors.text, fontSize: fonts.scaled(13), fontWeight: '700' },
  houseMeta: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), marginTop: 2 },
  gridScroll: { marginTop: 12 },
  gridScrollContent: { paddingBottom: 6 },
  grid: {
    backgroundColor: theme.colors.background,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    borderRadius: tokens.radius.sm,
    overflow: 'hidden',
  },
  gridRow: { flexDirection: 'row' },
  cell: {
    width: CELL_SIZE,
    height: CELL_SIZE,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.surfaceBorder,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surfaceAlt,
  },
  cellHouse: { backgroundColor: theme.colors.primary },
  cellSelf: { backgroundColor: theme.colors.primary },
  cellRole: { backgroundColor: theme.colors.primarySoft },
  notice: { color: theme.colors.primaryMuted, fontSize: fonts.scaled(12), marginTop: 14 },
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  editor: {
    width: '100%',
    maxWidth: 480,
    maxHeight: '86%',
    backgroundColor: theme.colors.surface,
    borderRadius: tokens.radius.lg,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    padding: tokens.spacing.lg,
  },
  editorTitle: { color: theme.colors.text, fontSize: fonts.scaled(16), fontWeight: '800' },
  editorScroll: { marginTop: 4 },
  editorMeta: { color: theme.colors.textFaint, fontSize: fonts.scaled(12), marginTop: 12 },
  editorActions: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 18 },
  editorButton: { marginLeft: 10 },
});
