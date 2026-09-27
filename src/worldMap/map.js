// 世界地图：40×40 网格上的房子。纯函数层负责坐标、放置与归属规则，
// 与 UI / 存储解耦，便于单测。数据量小（房子远少于格子数），整体存一个列表。

export const MAP_GRID_SIZE = 40;
export const MAP_CELL_COUNT = MAP_GRID_SIZE * MAP_GRID_SIZE;
export const MAP_OWNER_SELF = 'self';
export const MAP_HOUSE_NAME_MAX = 24;
// 房子编号固定补零到 3 位：自己的房子是 000，其余从 001 起。
export const MAP_HOUSE_NUMBER_PAD = 3;

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

// 把触点相对整块网格的像素坐标换算成格坐标；越界返回 null。
// 必须用「相对整块网格」的坐标：若触摸目标落在某个单元格上，locationX/Y 会相对
// 小格（恒在 0..CELL_SIZE），换算出来永远是左上角——纯函数化便于回归测试。
export function cellFromPoint(x, y, cellSize, size = MAP_GRID_SIZE) {
  const px = Number(x);
  const py = Number(y);
  const cell = Number(cellSize);
  if (!Number.isFinite(px) || !Number.isFinite(py) || !(cell > 0)) return null;
  const gx = Math.floor(px / cell);
  const gy = Math.floor(py / cell);
  if (!isValidCell(gx, gy, size)) return null;
  return { x: gx, y: gy };
}

export function makeMapHouseId(now = Date.now()) {
  return `house-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function normalizeMapHouse(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const x = Math.trunc(Number(source.x));
  const y = Math.trunc(Number(source.y));
  const rawOwnerId = clean(source.ownerId, 80);
  // 屋主是角色但 ownerId 为空属于坏数据（幽灵屋主）：没有可指的角色，
  // 降级为「我的房子」，避免渲染出没有归属的角色房子。
  const ownerType = source.ownerType === 'character' && rawOwnerId ? 'character' : MAP_OWNER_SELF;
  const residents = Array.isArray(source.residents)
    ? source.residents
      .map(item => clean(item, 80))
      .filter(Boolean)
      .filter((id, index, all) => all.indexOf(id) === index)
    : [];
  const createdAt = Number(source.createdAt);
  return {
    id: clean(source.id, 120) || makeMapHouseId(createdAt > 0 ? createdAt : Date.now()),
    x: Number.isFinite(x) ? x : -1,
    y: Number.isFinite(y) ? y : -1,
    name: clean(source.name, MAP_HOUSE_NAME_MAX),
    ownerType,
    // ownerId 为空表示“自己”；ownerType==='character' 时记角色 id
    ownerId: ownerType === 'character' ? rawOwnerId : '',
    ownerName: ownerType === 'character' ? clean(source.ownerName, 80) : '',
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
// 同时保证「每人最多住 1 栋」：本房住户会从其它房子的住户名单里移除（搬迁）。
// 必须在原位置替换（而非删了再追加）：编号按列表顺序生成，位置一变房号就变。
export function placeHouse(houses, house) {
  const next = normalizeMapHouse(house);
  if (!next.id || !isValidCell(next.x, next.y)) {
    return normalizeMapHouses(houses);
  }
  const residents = new Set(next.residents);
  const existing = normalizeMapHouses(houses);
  const isSamePlace = item => item.id === next.id || (item.x === next.x && item.y === next.y);
  const replaceIndex = existing.findIndex(isSamePlace);
  const rest = existing
    .filter(item => !isSamePlace(item))
    .map(item => {
      const remaining = item.residents.filter(id => !residents.has(id));
      return remaining.length === item.residents.length ? item : { ...item, residents: remaining };
    });
  if (replaceIndex < 0) return [...rest, next];
  const result = [...rest];
  result.splice(Math.min(replaceIndex, result.length), 0, next);
  return result;
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

// 房子编号：自己的房子固定 000，其余按给定顺序（调用方先排序）从 001 起补零。
// 返回 [{ house, number, label }]，number 为数字，label 为 3 位字符串。
export function assignHouseNumbers(houses) {
  const list = normalizeMapHouses(houses);
  let index = 1;
  return list.map(house => {
    const isSelf = house.ownerType === MAP_OWNER_SELF;
    const number = isSelf ? 0 : index;
    if (!isSelf) index += 1;
    return {
      house,
      number,
      label: String(number).padStart(MAP_HOUSE_NUMBER_PAD, '0'),
    };
  });
}

export function houseNumberLabel(house, houses) {
  const target = house && house.id;
  const found = assignHouseNumbers(houses).find(item => item.house.id === target);
  return found ? found.label : '';
}

// 每个人（自己或角色）最多拥有 1 栋房子。返回 ownerId → 已拥有的房子。
// 自己用 MAP_OWNER_SELF 作为 ownerId，避免与角色 id 混淆。
export function housesByOwner(houses) {
  const map = new Map();
  normalizeMapHouses(houses).forEach(house => {
    const key = house.ownerType === MAP_OWNER_SELF ? MAP_OWNER_SELF : house.ownerId;
    if (key && !map.has(key)) map.set(key, house);
  });
  return map;
}

// 校验能不能把某栋房子的屋主设为 owner（自己或角色）。返回 { ok, conflict }。
// 冲突指该 owner 已经拥有另一栋房子：只允许改「自己这一栋」，不允许再占第二栋。
export function canAssignOwner(houses, owner, houseId) {
  const key = owner && owner.type === 'character' ? clean(owner.id, 80) : MAP_OWNER_SELF;
  if (owner && owner.type === 'character' && !key) return { ok: false, conflict: null };
  const conflict = normalizeMapHouses(houses).find(house => {
    if (houseId && house.id === houseId) return false;
    const existingKey = house.ownerType === MAP_OWNER_SELF ? MAP_OWNER_SELF : house.ownerId;
    return existingKey === key;
  }) || null;
  return { ok: !conflict, conflict };
}

// 一个角色最多住 1 栋房子：返回它当前作为「住户」所在的房子（不含它自己拥有的房）。
export function houseResidedBy(houses, characterId) {
  const id = clean(characterId, 80);
  if (!id) return null;
  return normalizeMapHouses(houses).find(
    house => Array.isArray(house.residents) && house.residents.includes(id)
  ) || null;
}

// 校验能不能让某角色住进某栋房子（住户名额 1 个）。返回 { ok, conflict }。
// 自己（用户）不占住户名额，只能靠拥有 000 号房来「住」。
export function canAddResident(houses, characterId, houseId) {
  const id = clean(characterId, 80);
  if (!id) return { ok: false, conflict: null };
  const current = houseResidedBy(houses, id);
  if (!current || current.id === houseId) return { ok: true, conflict: null };
  return { ok: false, conflict: current };
}

// 同一栋房子里的全部角色：屋主（若为角色）+ 住户，去重。用于动态联动的同住判定。
export function housemateCharacterIds(houses, characterId) {
  const id = clean(characterId, 80);
  if (!id) return [];
  const house = normalizeMapHouses(houses).find(houseItem => (
    (houseItem.ownerType === 'character' && houseItem.ownerId === id)
    || (Array.isArray(houseItem.residents) && houseItem.residents.includes(id))
  ));
  if (!house) return [];
  const ids = [];
  if (house.ownerType === 'character' && house.ownerId) ids.push(house.ownerId);
  (Array.isArray(house.residents) ? house.residents : []).forEach(residentId => {
    if (residentId) ids.push(residentId);
  });
  return [...new Set(ids)].filter(item => item !== id);
}
