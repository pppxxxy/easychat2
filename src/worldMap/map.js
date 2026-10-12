// 世界地图：40×40 网格上的房子。纯函数层负责坐标、放置与归属规则，
// 与 UI / 存储解耦，便于单测。数据量小（房子远少于格子数），整体存一个列表。

export const MAP_GRID_SIZE = 40;
export const MAP_CELL_COUNT = MAP_GRID_SIZE * MAP_GRID_SIZE;
export const MAP_OWNER_SELF = 'self';
// 无主房：角色被删除后，它留下的房子若不能归给「自己」（自己已经有一栋了），
// 就必须有一个「谁也不属于」的状态——否则只能硬塞成 self，于是出现两栋 self，
// 编号都算成 000，而且第二栋再也编辑不了（canAssignOwner 把它当成「自己的另一栋」冲突）。
export const MAP_OWNER_NONE = 'none';
export const MAP_HOUSE_NAME_MAX = 24;
// 房子编号固定补零到 3 位：自己的房子是 000，其余从 001 起。
// 无主房没有主人可指，因此不给编号（label 为空），也就不会去抢 000。
export const MAP_HOUSE_NUMBER_PAD = 3;
// 无主房的默认显示名（调用方可用 strings.orphanedHouse 按当前语言覆盖）。
const DEFAULT_ORPHANED_HOUSE_NAME = '无主房';

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
  // 无主态（MAP_OWNER_NONE）必须原样保留：它就是「谁也归不上」的合法状态。
  const ownerType = source.ownerType === 'character' && rawOwnerId
    ? 'character'
    : (source.ownerType === MAP_OWNER_NONE ? MAP_OWNER_NONE : MAP_OWNER_SELF);
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

// 角色被删除时：抹掉它作为屋主的房子归属，并从所有房子的住户里移除。
//
// 归属降级必须同时守住「每人最多 1 栋」——这条规则此前只在 UI 指派路径
// （MapPanel → canAssignOwner）上守，降级路径直接绕过了它：
//   删掉某角色 → 它名下的房子一律降级为 self → 若用户已有自己的房，就有两栋 self，
//   assignHouseNumbers 给两栋都发 number=0/label='000'，再编辑第二栋时
//   canAssignOwner(houses, {type:'self'}) 命中第一栋为冲突 → MapPanel 弹「转移失败」
//   并 return，改名/改住户都存不进去，只能删房。
// 现在的规则：用户还没有自己的房 → 这栋归用户（沿用原行为）；用户已经有了 →
// 这栋变成无主房（MAP_OWNER_NONE），不占「自己」这个唯一名额，也不会去抢 000 号。
export function detachCharacterFromMap(houses, characterIds) {
  const ids = new Set(
    (Array.isArray(characterIds) ? characterIds : []).map(id => clean(id, 80)).filter(Boolean)
  );
  if (ids.size === 0) return normalizeMapHouses(houses);
  const list = normalizeMapHouses(houses);
  // 降级前先看「自己」是否已经有房：有则后面被摘掉归属的房子只能进无主态。
  const selfTaken = list.some(house => house.ownerType === MAP_OWNER_SELF);
  let gaveToSelf = false;
  return list.map(house => {
    const ownerRemoved = house.ownerType === 'character' && ids.has(house.ownerId);
    const residents = house.residents.filter(id => !ids.has(id));
    if (!ownerRemoved && residents.length === house.residents.length) return house;
    if (!ownerRemoved) return { ...house, residents };
    // 只有第一栋能归用户：这一轮里可能有多栋房同时失去屋主。
    const toSelf = !selfTaken && !gaveToSelf;
    if (toSelf) gaveToSelf = true;
    return {
      ...house,
      ownerType: toSelf ? MAP_OWNER_SELF : MAP_OWNER_NONE,
      ownerId: '',
      ownerName: '',
      // 无主房没有屋主，名字会显示成「无主房」；原来那个角色名不能再留着当房名，
      // 否则界面上看起来还像那个角色的房子（用户已把它删了）。
      name: toSelf ? house.name : (house.name || DEFAULT_ORPHANED_HOUSE_NAME),
      residents,
    };
  });
}

// 展示文案可由调用方（组件）用 t() 经 strings 传入；默认值保留中文基准文案，
// 使纯函数测试与非组件调用方不受影响。
export function describeHouseOwner(house, characters = [], strings = {}) {
  if (!house) return '';
  const selfHouse = strings.selfHouse || '我的房子';
  const orphanedHouse = strings.orphanedHouse || DEFAULT_ORPHANED_HOUSE_NAME;
  // 无主房不能说成「我的房子」：它恰恰是「没有归给自己」的那栋。
  if (house.ownerType === MAP_OWNER_NONE) return orphanedHouse;
  if (house.ownerType !== 'character') return selfHouse;
  const found = (Array.isArray(characters) ? characters : [])
    .find(item => item && item.id === house.ownerId);
  const name = clean(house.ownerName, 80) || (found && found.name) || strings.characterFallback || '角色';
  const template = strings.ownedBy || '{name}的房子';
  return template.replace('{name}', name);
}

export function houseResidentNames(house, characters = [], strings = {}) {
  if (!house) return [];
  const unnamed = strings.unnamed || '未命名';
  const deleted = strings.deletedCharacter || '已删除角色';
  const map = new Map();
  (Array.isArray(characters) ? characters : []).forEach(item => {
    if (item && item.id) map.set(item.id, clean(item.name, 80) || unnamed);
  });
  return (Array.isArray(house.residents) ? house.residents : [])
    .map(id => map.get(id) || deleted)
    .filter(Boolean);
}

// 房子编号：自己的房子固定 000，其余按给定顺序（调用方先排序）从 001 起补零。
// 无主房没有主人可指 → 不发编号（number 为 null、label 为空），因此不会出现
// 「两栋都叫 000」这种撞号；角色的 001、002 也不会因为多了一栋无主房而整体错位。
// 返回 [{ house, number, label }]，number 为数字（无主房为 null），label 为 3 位字符串。
export function assignHouseNumbers(houses) {
  const list = normalizeMapHouses(houses);
  let index = 1;
  return list.map(house => {
    if (house.ownerType === MAP_OWNER_NONE) {
      return { house, number: null, label: '' };
    }
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
// 无主房不属于任何人，不进表（它不占「自己」那唯一一个名额）。
export function housesByOwner(houses) {
  const map = new Map();
  normalizeMapHouses(houses).forEach(house => {
    if (house.ownerType === MAP_OWNER_NONE) return;
    const key = house.ownerType === MAP_OWNER_SELF ? MAP_OWNER_SELF : house.ownerId;
    if (key && !map.has(key)) map.set(key, house);
  });
  return map;
}

// 校验能不能把某栋房子的屋主设为 owner（自己或角色）。返回 { ok, conflict }。
// 冲突指该 owner 已经拥有另一栋房子：只允许改「自己这一栋」，不允许再占第二栋。
// 无主房对任何 owner 都不构成冲突——这正是它存在的意义：删角色留下的房子
// 必须还能被别人（含用户自己）接管，否则它就永远编辑不了。
export function canAssignOwner(houses, owner, houseId) {
  const type = owner ? owner.type : MAP_OWNER_SELF;
  // 无主（不指派给任何人）永远不冲突：没人可争。
  if (type === MAP_OWNER_NONE) return { ok: true, conflict: null };
  const key = type === 'character' ? clean(owner.id, 80) : MAP_OWNER_SELF;
  if (type === 'character' && !key) return { ok: false, conflict: null };
  const conflict = normalizeMapHouses(houses).find(house => {
    if (houseId && house.id === houseId) return false;
    if (house.ownerType === MAP_OWNER_NONE) return false;
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
  const list = normalizeMapHouses(houses);
  // 住户优先、其次屋主：一个角色可能同时「拥有 A」又「住进 B」，其住所应取 B。
  // 用 .find 只认第一栋会随数组顺序漏掉某一边的同住角色，这里显式定唯一住所。
  const house = list.find(houseItem => (
    Array.isArray(houseItem.residents) && houseItem.residents.includes(id)
  )) || list.find(houseItem => (
    houseItem.ownerType === 'character' && houseItem.ownerId === id
  ));
  if (!house) return [];
  const ids = [];
  if (house.ownerType === 'character' && house.ownerId) ids.push(house.ownerId);
  (Array.isArray(house.residents) ? house.residents : []).forEach(residentId => {
    if (residentId) ids.push(residentId);
  });
  return [...new Set(ids)].filter(item => item !== id);
}
