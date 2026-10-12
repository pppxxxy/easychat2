import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  assignHouseNumbers,
  canAddResident,
  canAssignOwner,
  cellFromPoint,
  describeHouseOwner,
  detachCharacterFromMap,
  houseAtCell,
  houseNumberLabel,
  houseResidentNames,
  houseResidedBy,
  housesByOwner,
  housemateCharacterIds,
  isValidCell,
  makeMapHouseId,
  MAP_GRID_SIZE,
  MAP_OWNER_NONE,
  MAP_OWNER_SELF,
  normalizeMapHouse,
  normalizeMapHouses,
  placeHouse,
  removeHouseAtCell,
} from '../src/worldMap/map.js';
import { zhCN } from '../src/i18n/locales/zh-CN.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = name => readFileSync(path.join(HERE, '..', 'src', name), 'utf8');
const STORAGE_WORLD_MAP_SOURCE = read('storage/worldMap.js');
const PANEL_SOURCE = read('MapPanel.js');


test('坐标合法性限制在 40×40 内', () => {
  assert.equal(MAP_GRID_SIZE, 40);
  assert.equal(isValidCell(0, 0), true);
  assert.equal(isValidCell(39, 39), true);
  assert.equal(isValidCell(40, 0), false);
  assert.equal(isValidCell(-1, 0), false);
  assert.equal(isValidCell(1.9, 2.9), true); // 取整后合法
});

test('触点坐标换算格子：不同位置得到不同格子，越界返回 null', () => {
  const CELL = 26;
  // 回归：以前内层单元格抢走触摸，locationX/Y 恒在 0..26，永远解析成左上角。
  assert.deepEqual(cellFromPoint(1, 1, CELL), { x: 0, y: 0 });
  assert.deepEqual(cellFromPoint(27, 27, CELL), { x: 1, y: 1 });
  assert.deepEqual(cellFromPoint(CELL * 10 + 5, CELL * 20 + 5, CELL), { x: 10, y: 20 });
  // 不同位置必须给出不同格子（防「恒为左上角」回归）
  assert.notDeepEqual(
    cellFromPoint(CELL * 10 + 5, CELL * 20 + 5, CELL),
    cellFromPoint(5, 5, CELL)
  );
  // 越界 → null
  assert.equal(cellFromPoint(CELL * 40, 0, CELL), null);
  assert.equal(cellFromPoint(-1, 0, CELL), null);
  assert.equal(cellFromPoint(NaN, 0, CELL), null);
  assert.equal(cellFromPoint(0, 0, 0), null);
});

test('房子规范化：非法坐标丢弃，住户去重', () => {
  const house = normalizeMapHouse({
    id: 'h1', x: 3, y: 4, name: '  小屋  ', ownerType: 'character', ownerId: 'c1',
    residents: ['a', 'a', '', 'b'],
  });
  assert.equal(house.name, '小屋');
  assert.equal(house.ownerType, 'character');
  assert.deepEqual(house.residents, ['a', 'b']);

  const self = normalizeMapHouse({ x: 1, y: 1, ownerType: 'character', ownerId: '' });
  // 幽灵屋主（character 但 ownerId 为空）降级为「我的房子」，避免渲染出没有归属的角色房
  assert.equal(self.ownerType, MAP_OWNER_SELF);
  assert.equal(self.ownerId, '');
  assert.equal(self.ownerName, '');

  const list = normalizeMapHouses([
    { id: 'a', x: 0, y: 0, name: 'A' },
    { id: 'bad', x: 99, y: 0, name: '越界' },
    { id: 'none', y: 1, name: '无 x' },
  ]);
  assert.deepEqual(list.map(item => item.id), ['a']);
});

test('一格只能有一个房子：同格后写覆盖', () => {
  const list = normalizeMapHouses([
    { id: 'a', x: 5, y: 5, name: '旧' },
    { id: 'b', x: 5, y: 5, name: '新' },
  ]);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, '新');
});

test('放置 / 查找 / 删除', () => {
  let houses = [];
  houses = placeHouse(houses, { id: 'h1', x: 2, y: 3, name: '我的家' });
  assert.equal(houses.length, 1);
  assert.equal(houseAtCell(houses, 2, 3).name, '我的家');
  assert.equal(houseAtCell(houses, 2, 4), null);

  // 同一格再放 → 覆盖
  houses = placeHouse(houses, { id: 'h1', x: 2, y: 3, name: '改名' });
  assert.equal(houses.length, 1);
  assert.equal(houseAtCell(houses, 2, 3).name, '改名');

  // 越界放置不生效
  houses = placeHouse(houses, { id: 'h2', x: 41, y: 0 });
  assert.equal(houses.length, 1);

  houses = removeHouseAtCell(houses, 2, 3);
  assert.equal(houses.length, 0);
});

test('房子可住任意多角色（不设人数上限）', () => {
  const residents = Array.from({ length: 300 }, (_, i) => `c${i}`);
  const house = normalizeMapHouse({ id: 'h', x: 0, y: 0, residents });
  assert.equal(house.residents.length, 300);
});

test('角色删除：屋主降级（自己还没房 → 归自己），住户被移除', () => {
  const houses = normalizeMapHouses([
    { id: 'h1', x: 0, y: 0, ownerType: 'character', ownerId: 'c1', ownerName: '晚星', residents: ['c1', 'c2'] },
    { id: 'h2', x: 1, y: 0, ownerType: 'character', ownerId: 'c2', ownerName: '晨曦', residents: ['c1'] },
    { id: 'h3', x: 2, y: 0, ownerType: 'character', ownerId: 'c3', ownerName: '丙', residents: ['c1', 'c3'] },
  ]);
  const next = detachCharacterFromMap(houses, ['c1']);
  const h1 = next.find(item => item.id === 'h1');
  const h2 = next.find(item => item.id === 'h2');
  const h3 = next.find(item => item.id === 'h3');
  // c1 是 h1 的屋主，而「自己」还没有房 → 归自己，且不再是住户
  assert.equal(h1.ownerType, MAP_OWNER_SELF);
  assert.equal(h1.ownerId, '');
  assert.deepEqual(h1.residents, ['c2']);
  // c2 仍是 h2 的屋主，只把住户 c1 去掉
  assert.equal(h2.ownerType, 'character');
  assert.deepEqual(h2.residents, []);
  // 别人家的房子只去掉 c1
  assert.deepEqual(h3.residents, ['c3']);
  // 房子数量不变
  assert.equal(next.length, 3);
});

// 回归：删除角色时「每人最多 1 栋」曾被降级路径绕过——它只在 UI 指派路径
// （canAssignOwner）上守。用户已有自己的房时，被删角色的房子也降级成 self，
// 于是两栋 self 都被编号成 000，再编辑第二栋必然命中 canAssignOwner 冲突，
// MapPanel 弹「转移失败」并 return，那栋房就永远存不进去（改名/改住户都不行）。
test('角色删除：用户已有自己的房 → 降级成无主房，绝不出现两栋 000', () => {
  const houses = normalizeMapHouses([
    { id: 'mine', x: 0, y: 0, name: '我的家' },
    { id: 'h1', x: 1, y: 0, ownerType: 'character', ownerId: 'c1', ownerName: '晚星' },
    { id: 'h2', x: 2, y: 0, ownerType: 'character', ownerId: 'c2', ownerName: '晨曦' },
  ]);
  const next = detachCharacterFromMap(houses, ['c1']);
  const h1 = next.find(item => item.id === 'h1');
  assert.equal(h1.ownerType, MAP_OWNER_NONE);
  assert.equal(h1.ownerId, '');
  assert.equal(h1.ownerName, '');
  // 自己仍然只有一栋（唯一名额没被占掉）
  assert.equal(housesByOwner(next).get(MAP_OWNER_SELF).id, 'mine');
  assert.equal(housesByOwner(next).has(''), false);
  // 编号：只有自己的房是 000；无主房不发编号 → 不再撞号
  const numbered = assignHouseNumbers(next);
  const byId = Object.fromEntries(numbered.map(item => [item.house.id, item.label]));
  assert.equal(byId.mine, '000');
  assert.equal(byId.h1, '');
  assert.equal(byId.h2, '001');
  assert.equal(numbered.filter(item => item.label === '000').length, 1);
  assert.equal(houseNumberLabel({ id: 'h1' }, next), '');
  // 关键：这栋房现在编辑得动。① 屋主保持无主（MapPanel 打开编辑器时不会误设成「自己」
  // 而弹「转移失败」）② 想指派给任何还没有房的人都能成。
  assert.equal(canAssignOwner(next, { type: MAP_OWNER_NONE }, 'h1').ok, true);
  assert.equal(canAssignOwner(next, { type: 'character', id: 'c9' }, 'h1').ok, true);
  // 「自己」已经有一栋了，所以仍然不能把第二栋也收归自己（每人最多 1 栋照旧生效）
  assert.equal(canAssignOwner(next, { type: MAP_OWNER_SELF }, 'h1').ok, false);
  // 无主房显示为「无主房」，不能说成「我的房子」
  assert.equal(describeHouseOwner(h1, [], { selfHouse: '我的房子' }), '无主房');
  assert.equal(describeHouseOwner(h1, [], { orphanedHouse: 'vacant' }), 'vacant');
});

test('角色删除：一次摘掉多栋屋主时，只有第一栋归自己，其余进无主态', () => {
  const houses = normalizeMapHouses([
    { id: 'a', x: 0, y: 0, ownerType: 'character', ownerId: 'c1' },
    { id: 'b', x: 1, y: 0, ownerType: 'character', ownerId: 'c1' },
  ]);
  const next = detachCharacterFromMap(houses, ['c1']);
  assert.equal(next.find(item => item.id === 'a').ownerType, MAP_OWNER_SELF);
  assert.equal(next.find(item => item.id === 'b').ownerType, MAP_OWNER_NONE);
  // 恰好一栋 self，编号只有一个 000
  assert.equal(assignHouseNumbers(next).filter(item => item.label === '000').length, 1);
});

test('展示辅助：屋主描述、住户名', () => {
  const characters = [{ id: 'c1', name: '晚星' }, { id: 'c2', name: '晨曦' }];
  assert.equal(describeHouseOwner({ ownerType: MAP_OWNER_SELF }, characters), '我的房子');
  assert.equal(
    describeHouseOwner({ ownerType: 'character', ownerId: 'c1', ownerName: '晚星' }, characters),
    '晚星的房子'
  );
  // 无 ownerName 时回退角色库名字
  assert.equal(
    describeHouseOwner({ ownerType: 'character', ownerId: 'c2', ownerName: '' }, characters),
    '晨曦的房子'
  );
  // 无主房：既不是「我的房子」，也不是任何角色的房子
  assert.equal(describeHouseOwner({ ownerType: MAP_OWNER_NONE }, characters), '无主房');
  assert.equal(
    describeHouseOwner({ ownerType: MAP_OWNER_NONE }, characters, { selfHouse: '我的房子', orphanedHouse: 'Vacant' }),
    'Vacant'
  );
  assert.deepEqual(houseResidentNames({ residents: ['c1', 'c2'] }, characters), ['晚星', '晨曦']);
  assert.deepEqual(houseResidentNames({ residents: ['gone'] }, characters), ['已删除角色']);
});

test('无主态：规范化保留、不进 housesByOwner、不参与冲突', () => {
  // 规范化不能把 none 吃成 self（否则「两栋 000」立刻回归）
  assert.equal(normalizeMapHouse({ id: 'h', x: 0, y: 0, ownerType: MAP_OWNER_NONE }).ownerType, MAP_OWNER_NONE);
  assert.equal(normalizeMapHouse({ id: 'h', x: 0, y: 0, ownerType: 'nonsense' }).ownerType, MAP_OWNER_SELF);
  const houses = normalizeMapHouses([
    { id: 'mine', x: 0, y: 0, name: '我的' },
    { id: 'vacant', x: 1, y: 0, ownerType: MAP_OWNER_NONE },
  ]);
  assert.equal(housesByOwner(houses).size, 1, '无主房不进 owner 表');
  // 无主房对任何人都不是冲突：还能被接管
  assert.equal(canAssignOwner(houses, { type: MAP_OWNER_SELF }, 'vacant').ok, false); // 自己已有房
  assert.equal(canAssignOwner(houses, { type: 'character', id: 'c1' }, 'vacant').ok, true);
  // 反过来：把已有房改成无主永远允许（「不指派」没人可争）
  assert.equal(canAssignOwner(houses, { type: MAP_OWNER_NONE }, 'mine').ok, true);
  assert.equal(canAssignOwner(houses, { type: MAP_OWNER_NONE }, 'vacant').ok, true);
});

test('MapPanel：无主房打开时保持无主（否则改名/改住户永远存不进去）', () => {
  // 面板 JSX 在 Node 里渲染不了，只锁源码接线：无主房必须原样带进编辑器，
  // 并且「无主」要作为可选项存在（用户能显式保持/指派）。
  assert.ok(PANEL_SOURCE.includes('MAP_OWNER_NONE'), '面板必须认识无主态');
  assert.ok(PANEL_SOURCE.includes('chooseOwnerNone'), '必须有「无主」选择分支');
  assert.ok(PANEL_SOURCE.includes("t('world.map.owner.none')"), '无主选项要走 i18n');
  assert.ok(PANEL_SOURCE.includes("t('world.map.house.orphaned')"), '无主房显示名要走 i18n');
  // 无主房不发编号 → 列表里不能渲染空徽章
  assert.ok(PANEL_SOURCE.includes("label || '—'"), '无编号房子要有占位显示');
});

test('地图 id 生成唯一', () => {
  const a = makeMapHouseId(1000);
  const b = makeMapHouseId(1000);
  assert.notEqual(a, b);
  assert.ok(a.startsWith('house-'));
});

test('地图存储：单键读写、损坏备份、删除联动', () => {
  assert.ok(STORAGE_WORLD_MAP_SOURCE.includes("const WORLD_MAP_KEY = '@easychat2_world_map'"));
  assert.ok(STORAGE_WORLD_MAP_SOURCE.includes('export async function getWorldMapStatus'));
  assert.ok(STORAGE_WORLD_MAP_SOURCE.includes('export function updateWorldMap'));
  assert.ok(STORAGE_WORLD_MAP_SOURCE.includes('backupCorruptValue(WORLD_MAP_KEY)'));
  assert.ok(STORAGE_WORLD_MAP_SOURCE.includes('detachCharacterFromWorldMap'));
  assert.ok(STORAGE_WORLD_MAP_SOURCE.includes('enqueueWorldMapMutation'));
  // 角色删除时联动：改由 worldMap 域注册生命周期钩子（storage/characterState.js 只跑钩子）
  assert.ok(STORAGE_WORLD_MAP_SOURCE.includes('onCharacterDeleted'), '地图域必须注册角色删除钩子');
  assert.ok(STORAGE_WORLD_MAP_SOURCE.includes('detachCharacterFromWorldMap'));
  assert.ok(read('storage/characterState.js').includes('runCharacterCleanup'), '保存编排必须调用钩子运行器');
});

test('地图入口已在拓展首页注册（Stack 化，不再 embedded）', () => {
  const home = read('extension/ExtensionHome.js');
  assert.ok(home.includes("route: 'ext-map'"), '首页有地图入口');
  assert.ok(read('extension/ExtensionStack.js').includes('MapPanel'), 'Stack 注册了 MapPanel');
  assert.equal(read('MapPanel.js').includes('embedded'), false, 'MapPanel 不再有 embedded prop');
});

test('地图面板：网格、放置、编辑、屋主与住户', () => {
  assert.ok(PANEL_SOURCE.includes('MAP_GRID_SIZE'));
  assert.ok(PANEL_SOURCE.includes('openCell'));
  assert.ok(PANEL_SOURCE.includes('onGridPress'));
  // 整块可点，内层 pointerEvents="none"，避免恒选左上角
  assert.ok(PANEL_SOURCE.includes('cellFromPoint'));
  assert.ok(PANEL_SOURCE.includes('pointerEvents="none"'));
  assert.ok(PANEL_SOURCE.includes('placeHouse'));
  assert.ok(PANEL_SOURCE.includes('removeHouseAtCell'));
  // 删除需二次确认
  assert.ok(PANEL_SOURCE.includes('confirmDeleteHouse'));
  assert.ok(PANEL_SOURCE.includes("t('map.alert.deleteHouse.body'"), '删除确认应引用 i18n 键');
  assert.ok(zhCN['map.alert.deleteHouse.body'].includes('确定删除'), '语言包中文值正确');
  assert.ok(PANEL_SOURCE.includes("t('map.editor.ownerLabel')"), '屋主标签应引用 i18n 键');
  assert.equal(zhCN['map.editor.ownerLabel'], '屋主', '语言包中文值正确');
  assert.ok(PANEL_SOURCE.includes("t('map.editor.residentsLabel')"), '住户标签应引用 i18n 键');
  assert.equal(zhCN['map.editor.residentsLabel'], '住户', '语言包中文值正确');
  assert.ok(PANEL_SOURCE.includes("t('map.owner.self')"), '我自己选项应引用 i18n 键');
  assert.equal(zhCN['map.owner.self'], '我自己', '语言包中文值正确');
  // 查看列表、房号、上限判定
  assert.ok(PANEL_SOURCE.includes('assignHouseNumbers'));
  assert.ok(PANEL_SOURCE.includes('listOpen'));
  assert.ok(PANEL_SOURCE.includes('houseNumberLabel'));
  assert.ok(PANEL_SOURCE.includes('canAssignOwner'));
  assert.ok(PANEL_SOURCE.includes('canAddResident'));
  assert.ok(PANEL_SOURCE.includes('CollapsibleSelect'));
});

test('房子编号：自己的固定 000，其余从 001 起补零', () => {
  const houses = normalizeMapHouses([
    { id: 'role2', x: 2, y: 0, ownerType: 'character', ownerId: 'c2', ownerName: '乙' },
    { id: 'mine', x: 0, y: 0, name: '我的' },
    { id: 'role1', x: 1, y: 0, ownerType: 'character', ownerId: 'c1', ownerName: '甲' },
  ]);
  const numbered = assignHouseNumbers(houses);
  const byId = Object.fromEntries(numbered.map(item => [item.house.id, item.label]));
  assert.equal(byId.mine, '000');
  // 角色房子按传入顺序编号 001、002
  assert.equal(byId.role2, '001');
  assert.equal(byId.role1, '002');
  assert.equal(houseNumberLabel({ id: 'mine' }, houses), '000');
});

test('每人最多拥有 1 栋：canAssignOwner 拦截已拥有者', () => {
  const houses = normalizeMapHouses([
    { id: 'h1', x: 0, y: 0, ownerType: 'character', ownerId: 'c1', ownerName: '甲' },
    { id: 'h2', x: 1, y: 0, name: '我的' },
  ]);
  // c1 已有 h1，不能再成为 h2 的屋主（编辑 h2 时）
  const blocked = canAssignOwner(houses, { type: 'character', id: 'c1' }, 'h2');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.conflict.id, 'h1');
  // 编辑自己这栋（h1）仍允许保持 c1
  assert.equal(canAssignOwner(houses, { type: 'character', id: 'c1' }, 'h1').ok, true);
  // 未拥有任何房的 c2 可以
  assert.equal(canAssignOwner(houses, { type: 'character', id: 'c2' }, 'h2').ok, true);
  // 自己已在 h2：别的房子不能再归自己
  assert.equal(canAssignOwner(houses, { type: MAP_OWNER_SELF }, 'h1').ok, false);
});

test('每人最多住 1 栋：canAddResident / houseResidedBy 拦截', () => {
  const houses = normalizeMapHouses([
    { id: 'h1', x: 0, y: 0, ownerType: 'character', ownerId: 'c1', ownerName: '甲', residents: ['c2'] },
    { id: 'h2', x: 1, y: 0, name: '我的' },
  ]);
  assert.equal(houseResidedBy(houses, 'c2').id, 'h1');
  // c2 已住 h1，不能再住 h2
  const blocked = canAddResident(houses, 'c2', 'h2');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.conflict.id, 'h1');
  // 保持原房或入住空房 c3 都可以
  assert.equal(canAddResident(houses, 'c2', 'h1').ok, true);
  assert.equal(canAddResident(houses, 'c3', 'h2').ok, true);
});

test('placeHouse 搬迁：同一角色住进新房后从旧房住户移除', () => {
  let houses = normalizeMapHouses([
    { id: 'h1', x: 0, y: 0, name: '甲房', residents: ['c1', 'c2'] },
    { id: 'h2', x: 1, y: 0, name: '乙房', residents: [] },
  ]);
  // 把 c1 搬到 h2
  houses = placeHouse(houses, { id: 'h2', x: 1, y: 0, name: '乙房', residents: ['c1'] });
  const h1 = houses.find(item => item.id === 'h1');
  const h2 = houses.find(item => item.id === 'h2');
  assert.deepEqual(h1.residents, ['c2']);
  assert.deepEqual(h2.residents, ['c1']);
});

test('housesByOwner：每个 owner 只留第一栋', () => {
  const houses = normalizeMapHouses([
    { id: 'h1', x: 0, y: 0, ownerType: 'character', ownerId: 'c1' },
    { id: 'h2', x: 1, y: 0, ownerType: 'character', ownerId: 'c1' },
    { id: 'mine', x: 2, y: 0, name: '我的' },
  ]);
  const map = housesByOwner(houses);
  assert.equal(map.get('c1').id, 'h1');
  assert.equal(map.get(MAP_OWNER_SELF).id, 'mine');
});

test('同住判定：屋主 + 住户都算，排除自己', () => {
  const houses = normalizeMapHouses([
    { id: 'h1', x: 0, y: 0, ownerType: 'character', ownerId: 'c1', ownerName: '甲', residents: ['c2', 'c3'] },
    { id: 'h2', x: 1, y: 0, name: '我的', residents: ['c4'] },
  ]);
  // 屋主 c1 的同住者：住户 c2、c3（不含自己）
  assert.deepEqual(housemateCharacterIds(houses, 'c1').sort(), ['c2', 'c3']);
  // 住户 c2 的同住者：屋主 c1 + 住户 c3
  assert.deepEqual(housemateCharacterIds(houses, 'c2').sort(), ['c1', 'c3']);
  // 不在任何房子里的角色没有同住者
  assert.deepEqual(housemateCharacterIds(houses, 'c9'), []);
});

test('同住判定：既拥有房子又住进别家时按住所取同住者，且与顺序无关', () => {
  const houses = normalizeMapHouses([
    { id: 'own', x: 0, y: 0, ownerType: 'character', ownerId: 'c1', residents: ['r1'] },
    { id: 'host', x: 1, y: 0, ownerType: 'character', ownerId: 'c2', residents: ['c1'] },
  ]);
  // c1 住进 c2 家：同住者应是 c2，而不是只认第一栋（自己家）的 r1
  assert.deepEqual(housemateCharacterIds(houses, 'c1').sort(), ['c2']);
  assert.deepEqual(housemateCharacterIds([...houses].reverse(), 'c1').sort(), ['c2']);
});

test('编辑房子保持原位置：房号不因保存而改变', () => {
  const houses = normalizeMapHouses([
    { id: 'self', x: 0, y: 0, name: '我的' },
    { id: 'h1', x: 1, y: 0, ownerType: 'character', ownerId: 'c1', ownerName: '甲' },
    { id: 'h2', x: 2, y: 0, ownerType: 'character', ownerId: 'c2', ownerName: '乙' },
  ]);
  // 改 h1 的名字后保存：位置不变，编号仍是 001
  const edited = placeHouse(houses, { ...houses[1], name: '甲的新家' });
  const numbered = assignHouseNumbers(edited);
  const labels = Object.fromEntries(numbered.map(item => [item.house.id, item.label]));
  assert.equal(labels.h1, '001');
  assert.equal(labels.h2, '002');
  assert.equal(labels.self, '000');
});
