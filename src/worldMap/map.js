// 世界地图：40×40 网格上的房子。纯函数层负责坐标、放置与归属规则，
// 与 UI / 存储解耦，便于单测。数据量小（房子远少于格子数），整体存一个列表。

export const MAP_GRID_SIZE = 40;
export const MAP_CELL_COUNT = MAP_GRID_SIZE * MAP_GRID_SIZE;
export const MAP_OWNER_SELF = 'self';
export const MAP_HOUSE_NAME_MAX = 24;
export const MAP_RESIDENT_LIMIT = 200;

const clean = (value, max = 0) => {
  const text = String(value == null ? '' : value).trim();
  if (!max || text.length <= max) return text;
  return text.slice(0, max);
};

export function isValidCell(x, y, size = MAP_GRID_SIZE) {
  const gx = Math.trunc(Number(x));
  const gy = Math.trunc(Number(y));
  return Number.isFinite(gx) && Number.isFinite(gy)
    && gx >= 0 && gx < size && gy >= 0 && gy < size;
}

export function makeMapHouseId(now = Date.now()) {
  return `house-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function normalizeMapHouse(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const x = Math.trunc(Number(source.x));
  const y = Math.trunc(Number(source.y));
  const ownerType = source.ownerType === 'character' ? 'character' : MAP_OWNER_SELF;
  const residents = Array.isArray(source.residents)
    ? source.residents
      .map(item => clean(item, 80))
      .filter(Boolean)
      .filter((id, index, all) => all.indexOf(id) === index)
      .slice(0, MAP_RESIDENT_LIMIT)
    : [];
  const createdAt = Number(source.createdAt);
  return {
    id: clean(source.id, 120) || makeMapHouseId(createdAt > 0 ? createdAt : Date.now()),
    x: Number.isFinite(x) ? x : -1,
    y: Number.isFinite(y) ? y : -1,
    name: clean(source.name, MAP_HOUSE_NAME_MAX),
    ownerType,
    // ownerId 为空表示“自己”；ownerType==='character' 时记角色 id
    ownerId: ownerType === 'character' ? clean(source.ownerId, 80) : '',
    ownerName: clean(source.ownerName, 80),
    residents,
    createdAt: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : 0,
  };
}

export function normalizeMapHouses(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const byCell = new Map();
  list.forEach(item => {
    const house = normalizeMapHouse(item);
    if (!house.id || !isValidCell(house.x, house.y)) return;
    // 一格只能有一个房子：后出现的覆盖先出现的，避免网格渲染时重叠。
    byCell.set(`${house.x}:${house.y}`, house);
  });
  return [...byCell.values()];
}

export function houseAtCell(houses, x, y) {
  const gx = Math.trunc(Number(x));
  const gy = Math.trunc(Number(y));
  return (Array.isArray(houses) ? houses : [])
    .find(item => item && item.x === gx && item.y === gy) || null;
}

// 放置/覆盖一格：同格已有房子则替换（编辑走这条），其余保留。
export function placeHouse(houses, house) {
  const next = normalizeMapHouse(house);
  if (!next.id || !isValidCell(next.x, next.y)) {
    return normalizeMapHouses(houses);
  }
  const rest = normalizeMapHouses(houses).filter(
    item => !(item.x === next.x && item.y === next.y)
  );
  return [...rest, next];
}

export function removeHouseAtCell(houses, x, y) {
  const gx = Math.trunc(Number(x));
  const gy = Math.trunc(Number(y));
  return normalizeMapHouses(houses).filter(item => !(item.x === gx && item.y === gy));
}

// 角色被删除时：抹掉它作为屋主的房子归属（降级为“自己”），并从所有房子的住户里移除。
export function detachCharacterFromMap(houses, characterIds) {
  const ids = new Set(
    (Array.isArray(characterIds) ? characterIds : []).map(id => clean(id, 80)).filter(Boolean)
  );
  if (ids.size === 0) return normalizeMapHouses(houses);
  return normalizeMapHouses(houses).map(house => {
    const ownerRemoved = house.ownerType === 'character' && ids.has(house.ownerId);
    const residents = house.residents.filter(id => !ids.has(id));
    if (!ownerRemoved && residents.length === house.residents.length) return house;
    return {
      ...house,
      ownerType: ownerRemoved ? MAP_OWNER_SELF : house.ownerType,
      ownerId: ownerRemoved ? '' : house.ownerId,
      ownerName: ownerRemoved ? '' : house.ownerName,
      residents,
    };
  });
}

// 统计与某角色相关的房子数（屋主或住户），用于展示/删除提示。
export function countHousesForCharacter(houses, characterId) {
  const id = clean(characterId, 80);
  if (!id) return 0;
  return (Array.isArray(houses) ? houses : []).filter(house => house && (
    (house.ownerType === 'character' && house.ownerId === id)
    || (Array.isArray(house.residents) && house.residents.includes(id))
  )).length;
}

export function describeHouseOwner(house, characters = []) {
  if (!house) return '';
  if (house.ownerType !== 'character') return '我的房子';
  const found = (Array.isArray(characters) ? characters : [])
    .find(item => item && item.id === house.ownerId);
  const name = clean(house.ownerName, 80) || (found && found.name) || '角色';
  return `${name}的房子`;
}

export function houseResidentNames(house, characters = []) {
  if (!house) return [];
  const map = new Map();
  (Array.isArray(characters) ? characters : []).forEach(item => {
    if (item && item.id) map.set(item.id, clean(item.name, 80) || '未命名');
  });
  return (Array.isArray(house.residents) ? house.residents : [])
    .map(id => map.get(id) || '已删除角色')
    .filter(Boolean);
}
