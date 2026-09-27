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

import { getWorldMap, updateWorldMap } from './storage';
import {
  describeHouseOwner,
  houseAtCell,
  houseResidentNames,
  makeMapHouseId,
  MAP_GRID_SIZE,
  MAP_OWNER_SELF,
  placeHouse,
  removeHouseAtCell,
} from './worldMap/map';
import { useApp } from './context/AppContext';
import { FieldGroup, PrimaryButton, SecondaryButton, TextField } from './ui';
import { useTheme } from './theme/ThemeContext';

const CELL_SIZE = 26;

// 世界地图：40×40 网格，用户可在任意格子放置房子（自己或角色的），
// 一个房子可容纳任意多个住户。点格子弹面板编辑，数据存本地。
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

  const closeEditor = useCallback(() => {
    setEditing(null);
  }, []);

  const chooseOwnerSelf = useCallback(() => {
    setDraftOwner({ type: MAP_OWNER_SELF, id: '', name: '' });
  }, []);

  const chooseOwnerCharacter = useCallback(character => {
    setDraftOwner({ type: 'character', id: character.id, name: character.name || '角色' });
  }, []);

  const toggleResident = useCallback(id => {
    setDraftResidents(current => (
      current.includes(id) ? current.filter(item => item !== id) : [...current, id]
    ));
  }, []);

  const persist = useCallback(async list => {
    const saved = await updateWorldMap(() => list);
    setHouses(saved);
    return saved;
  }, []);

  const saveHouse = useCallback(async () => {
    if (!editing) return;
    setSaving(true);
    try {
      const house = {
        id: editing.house ? editing.house.id : makeMapHouseId(),
        x: editing.x,
        y: editing.y,
        name: draftName,
        ownerType: draftOwner.type,
        ownerId: draftOwner.type === 'character' ? draftOwner.id : '',
        ownerName: draftOwner.type === 'character' ? draftOwner.name : '',
        residents: draftResidents,
        createdAt: editing.house ? editing.house.createdAt : Date.now(),
      };
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

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={theme.colors.primary} />
      </View>
    );
  }

  const Container = embedded ? View : ScrollView;
  const containerProps = embedded ? { style: styles.content } : { contentContainerStyle: styles.content };

  return (
    <Container {...containerProps}>
      <Text style={styles.title}>地图</Text>
      <Text style={styles.hint}>
        {`${MAP_GRID_SIZE}×${MAP_GRID_SIZE} 的网格。点任意格子放置房子，可留给自己，也可让角色居住；`}
        一个房子能住任意多个角色。左右滑动查看整张地图。
      </Text>
      <Text style={styles.legend}>
        {`共 ${houses.length} 座房子 · 我的 ${selfCount} · 角色的 ${roleCount}`}
      </Text>

      <ScrollView
        horizontal
        style={styles.gridScroll}
        contentContainerStyle={styles.gridScrollContent}
        showsHorizontalScrollIndicator
      >
        <View style={styles.grid}>
          {Array.from({ length: MAP_GRID_SIZE }).map((_, y) => (
            <View key={y} style={styles.gridRow}>
              {Array.from({ length: MAP_GRID_SIZE }).map((_, x) => {
                const house = houseLookup.get(`${x}:${y}`) || null;
                const isRoleHouse = !!house && house.ownerType === 'character';
                return (
                  <TouchableOpacity
                    key={x}
                    style={[
                      styles.cell,
                      house && styles.cellHouse,
                      house && (isRoleHouse ? styles.cellRole : styles.cellSelf),
                    ]}
                    onPress={() => openCell(x, y)}
                    activeOpacity={0.7}
                    accessibilityLabel={house
                      ? `${x},${y} ${describeHouseOwner(house, characters)}`
                      : `空格子 ${x},${y}`}
                  >
                    {house ? (
                      <Ionicons
                        name="home"
                        size={12}
                        color={isRoleHouse ? theme.colors.star : theme.colors.primaryContrast}
                      />
                    ) : null}
                  </TouchableOpacity>
                );
              })}
            </View>
          ))}
        </View>
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
                ? `编辑房子（${editing.x}, ${editing.y}）`
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

              <FieldGroup label="屋主">
                <View style={styles.chipWrap}>
                  <TouchableOpacity
                    style={[styles.chip, draftOwner.type === MAP_OWNER_SELF && styles.chipActive]}
                    onPress={chooseOwnerSelf}
                    activeOpacity={0.85}
                  >
                    <Text style={[styles.chipText, draftOwner.type === MAP_OWNER_SELF && styles.chipTextActive]}>
                      我自己
                    </Text>
                  </TouchableOpacity>
                  {characters.map(item => {
                    const active = draftOwner.type === 'character' && draftOwner.id === item.id;
                    return (
                      <TouchableOpacity
                        key={item.id}
                        style={[styles.chip, active && styles.chipActive]}
                        onPress={() => chooseOwnerCharacter(item)}
                        activeOpacity={0.85}
                      >
                        <Text style={[styles.chipText, active && styles.chipTextActive]}>
                          {item.name || '未命名'}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </FieldGroup>

              <FieldGroup label="住户" hint="可多选，一个房子住多少人都不限">
                {characters.length === 0 ? (
                  <Text style={styles.hint}>还没有角色，先到「角色」页添加后可让角色入住。</Text>
                ) : (
                  <View style={styles.chipWrap}>
                    {characters.map(item => {
                      const active = draftResidents.includes(item.id);
                      return (
                        <TouchableOpacity
                          key={item.id}
                          style={[styles.chip, active && styles.chipActive]}
                          onPress={() => toggleResident(item.id)}
                          activeOpacity={0.85}
                        >
                          <Text style={[styles.chipText, active && styles.chipTextActive]}>
                            {item.name || '未命名'}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
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
                <SecondaryButton title="删除" onPress={deleteHouse} disabled={saving} style={styles.editorButton} />
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
  title: { color: theme.colors.text, fontSize: fonts.scaled(18), fontWeight: '800', marginTop: 6 },
  hint: { color: theme.colors.textFaint, fontSize: fonts.scaled(12), lineHeight: fonts.scaled(18), marginTop: 8 },
  legend: { color: theme.colors.primaryMuted, fontSize: fonts.scaled(12), fontWeight: '700', marginTop: 10 },
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
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 8 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
    backgroundColor: theme.colors.surfaceAlt,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    marginRight: 8,
    marginBottom: 8,
  },
  chipActive: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  chipText: { color: theme.colors.textMuted, fontSize: fonts.scaled(12), fontWeight: '600' },
  chipTextActive: { color: theme.colors.primaryContrast },
  editorMeta: { color: theme.colors.textFaint, fontSize: fonts.scaled(12), marginTop: 12 },
  editorActions: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 18 },
  editorButton: { marginLeft: 10 },
});
