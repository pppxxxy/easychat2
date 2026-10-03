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
// 位置获取失败会抛错（由 UI 提示并保留旧位置）；反地理编码失败只退空描述。
export async function captureLocation() {
  const Location = loadLocationModule();
  const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
  const latitude = Number(position && position.coords && position.coords.latitude);
  const longitude = Number(position && position.coords && position.coords.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new Error('定位结果无效');
  }
  let description = '';
  try {
    const places = await Location.reverseGeocodeAsync({ latitude, longitude });
    description = formatPlace(Array.isArray(places) ? places[0] : null);
  } catch (error) {
    description = '';
  }
  return { latitude, longitude, description, updatedAt: Date.now() };
}
