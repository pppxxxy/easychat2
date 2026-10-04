// 定位服务（RN）：expo-location 前台权限、取点、反地理编码。
// 惰性 require：纯模块测试不会把原生模块拖进来；缺失时抛可读错误。

let cachedModule = null;

function loadLocationModule() {
  if (cachedModule) return cachedModule;
  try {
    cachedModule = require('expo-location');
  } catch (error) {
    throw new Error('当前构建未包含定位能力（expo-location）');
  }
  return cachedModule;
}

export function isLocationSupported() {
  try {
    loadLocationModule();
    return true;
  } catch (error) {
    return false;
  }
}

// 请求前台定位权限；已有授权直接返回 true。失败/拒绝返回 false（不抛）。
export async function ensureLocationPermission() {
  const Location = loadLocationModule();
  try {
    const current = await Location.getForegroundPermissionsAsync();
    if (current && current.status === 'granted') return true;
    const requested = await Location.requestForegroundPermissionsAsync();
    return Boolean(requested && requested.status === 'granted');
  } catch (error) {
    return false;
  }
}

// 取点与反地理编码的等待上限。没有它，卡住的定位会让界面永远 busy，
// 之后重开开关还可能把上一次的旧位置当成本次结果注入
//（需求 2.4 只要求「失败时保留旧位置」，不要求无限期等待）。
export const LOCATION_TIMEOUT_MS = 15000;

// 给任意 Promise 加超时；timeoutMs 非正数时原样透传（便于测试与显式关闭）。
// 超时用 reject 表达，调用方按普通失败处理；无论胜负都清掉定时器，避免悬挂。
export function withTimeout(promise, timeoutMs, message = '定位超时') {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer = null;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

// 反地理编码结果 → 一行地点：城市+区+街道+名称，去重后拼接；失败返回空串。
export function formatPlace(place) {
  if (!place || typeof place !== 'object') return '';
  const parts = [place.city, place.district, place.street, place.name]
    .map(value => String(value || '').trim())
    .filter(Boolean);
  const unique = [];
  parts.forEach(part => {
    if (!unique.includes(part)) unique.push(part);
  });
  return unique.join('').slice(0, 120);
}

// 获取一次当前位置（平衡精度）并尽力反地理编码。
// 位置获取失败/超时会抛错（由 UI 提示并保留旧位置）；反地理编码失败只退空描述。
export async function captureLocation({ timeoutMs = LOCATION_TIMEOUT_MS } = {}) {
  const Location = loadLocationModule();
  const position = await withTimeout(
    Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
    timeoutMs,
    '定位超时'
  );
  const latitude = Number(position && position.coords && position.coords.latitude);
  const longitude = Number(position && position.coords && position.coords.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new Error('定位结果无效');
  }
  let description = '';
  try {
    const places = await withTimeout(
      Location.reverseGeocodeAsync({ latitude, longitude }),
      timeoutMs,
      '反地理编码超时'
    );
    description = formatPlace(Array.isArray(places) ? places[0] : null);
  } catch (error) {
    description = '';
  }
  return { latitude, longitude, description, updatedAt: Date.now() };
}
