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

// 能力探测：`require` 成功**不等于**原生模块可用——未随包构建（旧安装包）
// 或原生侧异常时，JS 包在但方法缺失。这里连方法一起探，避免把
// 「当前构建没有定位能力」误报成「未获得定位权限」。
export function isLocationSupported() {
  try {
    const Location = loadLocationModule();
    return typeof Location.getCurrentPositionAsync === 'function'
      && typeof Location.getForegroundPermissionsAsync === 'function';
  } catch (error) {
    return false;
  }
}

// 请求前台定位权限：
//   返回 true  = 已授权；
//   返回 false = 查询成功但用户未授予（可提示去系统设置）；
//   抛错（code = LOCATION_UNAVAILABLE）= 原生模块/API 不可用。
// 第三种以前被吞成 false，导致用户明明在系统设置里给了权限，界面却一直说
// 「未获得定位权限」——必须与真正的拒绝区分开。
export async function ensureLocationPermission() {
  const Location = loadLocationModule();
  if (typeof Location.getForegroundPermissionsAsync !== 'function'
    || typeof Location.requestForegroundPermissionsAsync !== 'function') {
    const error = new Error('定位原生模块不可用');
    error.code = 'LOCATION_UNAVAILABLE';
    throw error;
  }
  const current = await Location.getForegroundPermissionsAsync();
  if (current && current.status === 'granted') return true;
  const requested = await Location.requestForegroundPermissionsAsync();
  return Boolean(requested && requested.status === 'granted');
}

// 取点与反地理编码的等待上限。没有它，卡住的定位会让界面永远 busy，
// 之后重开开关还可能把上一次的旧位置当成本次结果注入
//（需求 2.4 只要求「失败时保留旧位置」，不要求无限期等待）。
// 放宽到 20s：冷启动首次 GPS 定位（室内尤其）经常超过 15s——真机上表现为
// 「权限都给了还是获取位置失败」；超时后还有最近位置兜底（见 captureLocation）。
export const LOCATION_TIMEOUT_MS = 20000;

// 「最近位置」兜底的新鲜度上限：超过这个年龄的缓存点不再冒充当前位置。
export const LAST_KNOWN_MAX_AGE_MS = 10 * 60 * 1000;

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

// 模糊到区县的地点描述（只取城市+区）：注入对话用，不含街道/门牌。
// 「就算开启位置分享，也尽可能选择模糊位置」——精确描述只留给本地地图显示。
export function formatCoarsePlace(place) {
  if (!place || typeof place !== 'object') return '';
  const parts = [place.city, place.district]
    .map(value => String(value || '').trim())
    .filter(Boolean);
  const unique = [];
  parts.forEach(part => {
    if (!unique.includes(part)) unique.push(part);
  });
  return unique.join('').slice(0, 120);
}

// 读取系统「最近位置」缓存（10 分钟内、精度不限）：冷启动首点超时/系统服务刚开时
// 的一次兜底。任何异常/无缓存都返回 null，由调用方决定后续。
async function readLastKnownPosition(Location) {
  if (typeof Location.getLastKnownPositionAsync !== 'function') return null;
  try {
    const known = await Location.getLastKnownPositionAsync({ maxAge: LAST_KNOWN_MAX_AGE_MS });
    const latitude = Number(known && known.coords && known.coords.latitude);
    const longitude = Number(known && known.coords && known.coords.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    return known;
  } catch (error) {
    return null;
  }
}

// 获取一次当前位置（平衡精度）并尽力反地理编码。取点顺序：
//   系统定位服务关闭 → 直接尝试最近位置缓存（拿不到则抛 SERVICES_DISABLED，界面给
//   「去系统设置打开定位」的可操作文案，而不是笼统的「请稍后重试」）；
//   服务正常 → 当前点（20s 上限）；超时/失败 → 最近位置缓存兜底；仍无 → 抛错。
// 位置获取失败/超时会抛错（由 UI 提示并保留旧位置）；反地理编码失败只退空描述。
export async function captureLocation({ timeoutMs = LOCATION_TIMEOUT_MS } = {}) {
  const Location = loadLocationModule();
  if (typeof Location.getCurrentPositionAsync !== 'function') {
    const error = new Error('定位原生模块不可用');
    error.code = 'LOCATION_UNAVAILABLE';
    throw error;
  }
  let position = null;
  let fromCache = false;
  const servicesOn = typeof Location.hasServicesEnabledAsync === 'function'
    ? await Location.hasServicesEnabledAsync().catch(() => true)
    : true;
  if (!servicesOn) {
    position = await readLastKnownPosition(Location);
    fromCache = true;
    if (!position) {
      const error = new Error('系统定位服务未开启');
      error.code = 'SERVICES_DISABLED';
      throw error;
    }
  } else {
    try {
      // Accuracy 枚举在异常/过旧的包里可能缺失：缺了就不带精度参数取点，
      // 不能硬取 `Location.Accuracy.Balanced`（会抛 TypeError 被误当成「获取位置失败」）。
      const accuracy = Location.Accuracy && Location.Accuracy.Balanced;
      position = await withTimeout(
        Location.getCurrentPositionAsync(accuracy === undefined ? {} : { accuracy }),
        timeoutMs,
        '定位超时'
      );
    } catch (error) {
      const fallback = await readLastKnownPosition(Location);
      if (!fallback) throw error;
      position = fallback;
      fromCache = true;
    }
  }
  const latitude = Number(position && position.coords && position.coords.latitude);
  const longitude = Number(position && position.coords && position.coords.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new Error('定位结果无效');
  }
  // 兜底来的缓存点用其真实定位时间做年龄（拿不到时间戳就置 0：地图仍可标注，
  // 但对话注入的 30 分钟年龄门会拦下它，宁缺毋错）。
  let updatedAt = Date.now();
  if (fromCache) {
    const stamp = Number(position && position.timestamp);
    updatedAt = Number.isFinite(stamp) && stamp > 0 ? stamp : 0;
  }
  let description = '';
  let coarse = '';
  try {
    const places = await withTimeout(
      Location.reverseGeocodeAsync({ latitude, longitude }),
      timeoutMs,
      '反地理编码超时'
    );
    const first = Array.isArray(places) ? places[0] : null;
    description = formatPlace(first);
    coarse = formatCoarsePlace(first);
  } catch (error) {
    description = '';
    coarse = '';
  }
  return { latitude, longitude, description, coarse, updatedAt };
}
