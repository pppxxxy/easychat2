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
import { useApp } from './context/AppContext.js';
import { FieldGroup, PrimaryButton, SecondaryButton, TextField, CollapsibleSelect } from './ui/index.js';
import { useTheme } from './theme/ThemeContext.js';

const CELL_SIZE = 26;

// 世界地图：40×40 网格，用户可在任意格子放置房子（自己或角色的）。
// 规则：每人最多拥有 1 栋房子（自己的固定编号 000，其余按 001、002… 编号）；
// 每个角色最多住 1 栋房子（可同时拥有自己的一栋并住在别人家）。
// 点格子弹面板编辑；「查看」展开房子列表，点房子可看/改房主与住户。数据存本地。
// embedded=true 时面板不自带纵向滚动容器，交给外层折叠分组。
export default function MapPanel({ embedded = false }) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const { characters } = useApp();

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
      setNotice('读取地图失败，请重试。');
    } finally {
      setLoading(false);
    }
  }, []);

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
    setDraftOwner({ type: 'character', id: character.id, name: character.name || '角色' });
  }, []);

  const toggleResident = useCallback((character, houseId) => {
    setDraftResidents(current => {
      if (current.includes(character.id)) {
        return current.filter(item => item !== character.id);
      }
      // 一个角色最多住 1 栋：已在别家住则提示其现有房号。
      const check = canAddResident(houses, character.id, houseId);
      if (!check.ok) {
        const label = houseNumberLabel(check.conflict, houses);
        Alert.alert('无法入住', `${character.name || '该角色'}已经住在 ${label || '其他'} 号房子，每个角色最多住 1 栋。`);
        return current;
      }
      return [...current, character.id];
    });
  }, [houses]);

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
        '无法转让',
        draftOwner.type === 'character'
          ? `${draftOwner.name || '该角色'}已经拥有 ${label || '另一栋'} 号房子，每个人最多拥有 1 栋。`
          : `你已经有 ${label || '另一栋'} 号房子，每个人最多拥有 1 栋。`
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
      Alert.alert('保存失败', '请检查存储空间或权限。');
    } finally {
      setSaving(false);
    }
  }, [closeEditor, draftName, draftOwner, draftResidents, editing, houses, persist]);

  const deleteHouse = useCallback(async () => {
    if (!editing || !editing.house) return;
    setSaving(true);
    try {
      await persist(removeHouseAtCell(houses, editing.x, editing.y));
      closeEditor();
    } catch (error) {
      Alert.alert('删除失败', '请检查存储空间或权限。');
    } finally {
      setSaving(false);
    }
  }, [closeEditor, editing, houses, persist]);

  const confirmDeleteHouse = useCallback(() => {
    if (!editing || !editing.house) return;
    const label = numberLookup.get(editing.house.id) || '';
    Alert.alert('删除房子', `确定删除 ${label ? `${label} 号 ` : ''}（${editing.x}, ${editing.y}）的房子吗？`, [
      { text: '取消', style: 'cancel' },
      { text: '删除', style: 'destructive', onPress: () => { deleteHouse(); } },
    ]);
  }, [deleteHouse, editing, numberLookup]);

  const editingLabel = editing && editing.house ? numberLookup.get(editing.house.id) : '';

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={theme.colors.primary} />
      </View>
    );
  }

  const Container = embedded ? View : ScrollView;
  const containerProps = embedded ? { style: styles.content } : { contentContainerStyle: styles.content };

  const ownerOptions = [
    { value: MAP_OWNER_SELF, label: '我自己', meta: '000 号房' },
    ...characters.map(item => ({
      value: item.id,
      label: item.name || '未命名',
      meta: item.id === draftOwner.id ? '当前屋主' : '设为屋主',
    })),
  ];
  const ownerValue = draftOwner.type === 'character' ? draftOwner.id : MAP_OWNER_SELF;
  const ownerValueLabel = draftOwner.type === 'character'
    ? (draftOwner.name || '角色')
    : '我自己';

  return (
    <Container {...containerProps}>
      <View style={styles.titleRow}>
        <Text style={styles.title}>地图</Text>
        <TouchableOpacity
          style={styles.viewButton}
          onPress={() => setListOpen(v => !v)}
          activeOpacity={0.85}
          accessibilityRole="button"
        >
          <Ionicons name="list-outline" size={15} color={theme.colors.primarySoft} />
          <Text style={styles.viewButtonText}>{listOpen ? '收起' : '查看'}</Text>
        </TouchableOpacity>
      </View>
      <Text style={styles.hint}>
        {`${MAP_GRID_SIZE}×${MAP_GRID_SIZE} 的网格。点任意格子放置房子。自己固定住在 000 号房，`}
        其余房子按 001、002… 编号；每个人最多拥有 1 栋房子、每个角色最多住 1 栋（可同时拥有自己的房并住在别人家）。左右滑动查看整张地图。
      </Text>
      <Text style={styles.legend}>
        {`共 ${houses.length} 座房子 · 我的 ${selfCount} · 角色的 ${roleCount}`}
      </Text>

      {listOpen ? (
        <View style={styles.houseList}>
          {numberedHouses.length === 0 ? (
            <Text style={styles.hint}>还没有房子，点网格格子放置第一栋吧。</Text>
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
                    {house.name || describeHouseOwner(house, characters)}
                  </Text>
                  <Text style={styles.houseMeta} numberOfLines={1}>
                    {`屋主：${describeHouseOwner(house, characters)} · 住户：${houseResidentNames(house, characters).join('、') || '无'}`}
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
          accessibilityLabel="地图网格，点格子放置或编辑房子"
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
                ? `${editingLabel ? `${editingLabel} 号 ` : ''}房子（${editing.x}, ${editing.y}）`
                : `放置房子（${editing ? `${editing.x}, ${editing.y}` : ''}）`}
            </Text>
            <ScrollView keyboardShouldPersistTaps="handled" style={styles.editorScroll}>
              <FieldGroup label="房子名称" hint="可留空，留空时按屋主命名">
                <TextField
                  value={draftName}
                  onChangeText={setDraftName}
                  placeholder="例如：海边小屋"
                />
              </FieldGroup>

              <FieldGroup label="屋主" hint="每人最多拥有 1 栋房子，选中他人时可转让">
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
                  placeholder="选择屋主"
                />
              </FieldGroup>

              <FieldGroup label="住户" hint="一个角色最多住 1 栋；自己固定住 000 号房，不占住户名额">
                {characters.length === 0 ? (
                  <Text style={styles.hint}>还没有角色，先到「角色」页添加后可让角色入住。</Text>
                ) : (
                  <CollapsibleSelect
                    value=""
                    valueLabel={`已选 ${draftResidents.length} 人`}
                    placeholder="点开添加或移除住户"
                    options={[
                      ...draftResidents
                        .map(id => characters.find(item => item.id === id))
                        .filter(Boolean)
                        .map(item => ({ value: `remove:${item.id}`, label: `${item.name || '未命名'}（点击移出）` })),
                      ...characters
                        .filter(item => !draftResidents.includes(item.id))
                        .map(item => ({ value: `add:${item.id}`, label: `${item.name || '未命名'}（点击入住）` })),
                    ]}
                    emptyHint="暂无可添加的角色"
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
                  {`当前住户：${houseResidentNames(editing.house, characters).join('、') || '无'}`}
                </Text>
              ) : null}
            </ScrollView>

            <View style={styles.editorActions}>
              <SecondaryButton title="取消" onPress={closeEditor} style={styles.editorButton} />
              {editing && editing.house ? (
                <SecondaryButton title="删除" onPress={confirmDeleteHouse} disabled={saving} style={styles.editorButton} />
              ) : null}
              <PrimaryButton
                title={editing && editing.house ? '保存' : '放置'}
                onPress={saveHouse}
                disabled={saving}
                style={styles.editorButton}
              />
            </View>
          </View>
        </View>
      </Modal>
    </Container>
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
