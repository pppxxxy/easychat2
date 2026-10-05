// 位置相关的纯函数：坐标格式、WGS-84 → GCJ-02（火星坐标）转换、注入对话的位置行。
// 默认高德栅格瓦片是 GCJ-02，用 GPS（WGS-84）直接标注会有数百米偏移，展示前需转换。
// 全部为纯计算，供 Node 直测。
//
// 注入隐私设计：发给角色的位置**尽可能模糊**——优先用反地理编码的区县级描述
// （`coarse`，如「北京市东城区」），旧数据没有 coarse 时退全量描述，再退模糊坐标
// （2 位小数 ≈ 1.1km 网格）。精确坐标只用于本地地图标注，不进对话。

const PI = Math.PI;
const AXIS = 6378245.0;
const EE = 0.00669342162296594323;
const CHINA_LAT_MIN = 3.86;
const CHINA_LAT_MAX = 53.55;
const CHINA_LNG_MIN = 73.66;
const CHINA_LNG_MAX = 135.05;

function transformLat(x, y) {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(y * PI) + 40.0 * Math.sin((y / 3.0) * PI)) * 2.0 / 3.0;
  ret += (160.0 * Math.sin((y / 12.0) * PI) + 320 * Math.sin((y * PI) / 30.0)) * 2.0 / 3.0;
  return ret;
}

function transformLng(x, y) {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(x * PI) + 40.0 * Math.sin((x / 3.0) * PI)) * 2.0 / 3.0;
  ret += (150.0 * Math.sin((x / 12.0) * PI) + 300.0 * Math.sin((x / 30.0) * PI)) * 2.0 / 3.0;
  return ret;
}

// 境外判定：不在中国大陆包围盒内即视为境外（境外不做 GCJ 偏移）。
export function isOutOfChina(lat, lng) {
  const latitude = Number(lat);
  const longitude = Number(lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return true;
  return !(longitude > CHINA_LNG_MIN && longitude < CHINA_LNG_MAX
    && latitude > CHINA_LAT_MIN && latitude < CHINA_LAT_MAX);
}

// WGS-84 → GCJ-02。非法输入或境外原样返回（{ latitude, longitude }）。
export function wgs84ToGcj02(lat, lng) {
  const latitude = Number(lat);
  const longitude = Number(lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || isOutOfChina(latitude, longitude)) {
    return { latitude, longitude };
  }
  let dLat = transformLat(longitude - 105.0, latitude - 35.0);
  let dLng = transformLng(longitude - 105.0, latitude - 35.0);
  const radLat = (latitude / 180.0) * PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((AXIS * (1 - EE)) / (magic * sqrtMagic)) * PI);
  dLng = (dLng * 180.0) / ((AXIS / sqrtMagic) * Math.cos(radLat) * PI);
  return { latitude: latitude + dLat, longitude: longitude + dLng };
}

// GCJ-02 → WGS-84：在图上标点时的反向换算。
// 图上点的是 GCJ-02 坐标（高德瓦片），存盘必须回到 WGS-84，否则下次按 WGS-84
// 再转一次 GCJ-02 标注会叠加偏移。正向变换没有闭式逆解，用不动点迭代收敛：
// 每轮用「目标 − 正向(当前估计)」修正估计值，境内通常 2 轮内到 1e-9 量级。
const GCJ_INVERSE_ITERATIONS = 8;
const GCJ_INVERSE_EPSILON = 1e-9;

export function gcj02ToWgs84(lat, lng) {
  const latitude = Number(lat);
  const longitude = Number(lng);
  // 境外不做偏移，正向是恒等映射，反向同样原样返回。
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || isOutOfChina(latitude, longitude)) {
    return { latitude, longitude };
  }
  let guessLat = latitude;
  let guessLng = longitude;
  for (let i = 0; i < GCJ_INVERSE_ITERATIONS; i += 1) {
    const forward = wgs84ToGcj02(guessLat, guessLng);
    const dLat = forward.latitude - latitude;
    const dLng = forward.longitude - longitude;
    if (Math.abs(dLat) < GCJ_INVERSE_EPSILON && Math.abs(dLng) < GCJ_INVERSE_EPSILON) break;
    guessLat -= dLat;
    guessLng -= dLng;
  }
  return { latitude: guessLat, longitude: guessLng };
}

export function formatCoordinate(lat, lng, digits = 6) {
  const latitude = Number(lat);
  const longitude = Number(lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return '';
  const d = Math.max(0, Math.min(8, Math.floor(Number(digits)) || 6));
  return `${latitude.toFixed(d)}, ${longitude.toFixed(d)}`;
}

// 位置的可读描述：优先反地理编码文本，缺失时退回经纬度；无有效位置返回空串。
export function describeLocation(location) {
  const source = location && typeof location === 'object' ? location : null;
  if (!source) return '';
  const description = String(source.description || '').trim();
  if (description) return description;
  return formatCoordinate(source.latitude, source.longitude);
}

// 位置注入的默认年龄上限。过期位置不如没有位置：模型拿到「三天前」的坐标
// 会自信地说错，宁可这一轮不注入（取点失败保留旧位置只服务于地图显示）。
export const LOCATION_MAX_AGE_MS = 30 * 60 * 1000;

// 注入对话的坐标兜底精度：2 位小数 ≈ 1.1km 网格。够角色知道「大概在哪」，
// 又不足以定位到楼栋（精确坐标只留在本地地图上）。
export const INJECT_COORD_DIGITS = 2;

// 注入对话系统提示的位置行；未开启、无有效位置或位置过旧返回空串
//（保证关闭态与现状一致）。`maxAgeMs` 传 null/Infinity 可显式不限龄（测试用）。
export function buildLocationText(enabled, location, { maxAgeMs = LOCATION_MAX_AGE_MS, now = Date.now() } = {}) {
  if (!enabled) return '';
  const source = location && typeof location === 'object' ? location : null;
  if (!source) return '';
  // 模糊优先：区县级 coarse → 旧数据退全量描述 → 再退模糊坐标（都取不到才空）。
  const description = String(source.coarse || '').trim()
    || String(source.description || '').trim()
    || formatCoordinate(source.latitude, source.longitude, INJECT_COORD_DIGITS);
  if (!description) return '';
  const unlimited = maxAgeMs === null || maxAgeMs === undefined || !Number.isFinite(maxAgeMs);
  if (!unlimited) {
    const updatedAt = Number(source.updatedAt);
    // 没有可信时间戳的位置无法判龄，按过期处理（宁缺毋错）。
    if (!Number.isFinite(updatedAt) || updatedAt <= 0) return '';
    if (now - updatedAt > maxAgeMs) return '';
  }
  return `[当前位置] ${description}`;
}
