// 定位服务：超时包装的纯函数行为 + 取点调用必须真的走超时。
// （expo-location 本身在 Node 里跑不起来，这里只测可测的部分。）

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { LOCATION_TIMEOUT_MS, formatCoarsePlace, formatPlace, withTimeout } from '../src/location/service.js';

test('formatPlace / formatCoarsePlace：全量与区县级描述（模糊注入用 coarse）', () => {
  const place = { city: '北京市', district: '东城区', street: '景山街道', name: '某小区' };
  assert.equal(formatPlace(place), '北京市东城区景山街道某小区');
  assert.equal(formatCoarsePlace(place), '北京市东城区', '粗描述只保留城市+区');
  assert.equal(formatCoarsePlace({ city: '北京市' }), '北京市');
  assert.equal(formatCoarsePlace({ city: '北京市', district: '北京市' }), '北京市', '重复段去重');
  assert.equal(formatCoarsePlace(null), '');
});

function readSource(relativePath) {
  return fs.readFileSync(path.resolve(relativePath), 'utf8');
}

test('withTimeout：内层先完成时原样返回结果', async () => {
  const value = await withTimeout(Promise.resolve({ latitude: 1 }), 1000, '超时');
  assert.deepEqual(value, { latitude: 1 });
});

test('withTimeout：内层不落地时按超时拒绝，并带可读信息', async () => {
  const never = new Promise(() => {});
  await assert.rejects(
    () => withTimeout(never, 20, '定位超时'),
    (error) => error instanceof Error && error.message === '定位超时',
  );
});

test('withTimeout：内层抛错时原样透传（不被超时掩盖）', async () => {
  const boom = Promise.reject(new Error('定位结果无效'));
  await assert.rejects(
    () => withTimeout(boom, 1000, '定位超时'),
    (error) => error.message === '定位结果无效',
  );
});

test('withTimeout：非正/非法超时值不包超时（原样透传）', async () => {
  const value = await withTimeout(Promise.resolve('ok'), 0, '超时');
  assert.equal(value, 'ok');
  const value2 = await withTimeout(Promise.resolve('ok'), Number.NaN, '超时');
  assert.equal(value2, 'ok');
});

test('超时默认值存在且为正数（真机取点卡住时必须能复位 busy）', () => {
  assert.ok(Number.isFinite(LOCATION_TIMEOUT_MS) && LOCATION_TIMEOUT_MS > 0);
});

test('captureLocation：取点与反地理编码都必须经 withTimeout（卡住也要返回）', () => {
  const source = readSource('src/location/service.js');
  // 精确钉住两处调用，避免「定义了 withTimeout 却没用上」这种假修
  assert.ok(
    /withTimeout\(\s*Location\.getCurrentPositionAsync\(/.test(source),
    '取点必须包 withTimeout',
  );
  assert.ok(
    /withTimeout\(\s*Location\.reverseGeocodeAsync\(/.test(source),
    '反地理编码也必须包 withTimeout（它卡住同样会让界面一直 busy）',
  );
  assert.ok(/export async function captureLocation\(\{ timeoutMs = LOCATION_TIMEOUT_MS \}/.test(source),
    'captureLocation 必须接受可调超时（默认值来自 LOCATION_TIMEOUT_MS）');
});

test('captureLocation：系统服务检查、最近位置兜底与可诊断错误码', () => {
  const source = readSource('src/location/service.js');
  // 系统定位服务关闭：不能笼统报「请稍后重试」，要抛可诊断的 SERVICES_DISABLED。
  assert.ok(source.includes('hasServicesEnabledAsync'), '取点前必须检查系统定位服务是否开启');
  assert.ok(source.includes("error.code = 'SERVICES_DISABLED'"), '服务关闭且无缓存时抛 SERVICES_DISABLED');
  // 超时/失败兜底一次「最近位置」缓存（10 分钟新鲜度上限）。
  assert.ok(source.includes('getLastKnownPositionAsync'), '必须有最近位置兜底');
  assert.ok(/LAST_KNOWN_MAX_AGE_MS = 10 \* 60 \* 1000/.test(source), '缓存点新鲜度上限 10 分钟');
  // 兜底点用其真实定位时间做年龄（时间戳缺失置 0：地图可标注、对话注入被年龄门拦下）。
  assert.ok(/fromCache/.test(source) && source.includes('position.timestamp'), '缓存点必须保留真实时间戳');
  // 反地理编码同时产出全量与区县级描述。
  assert.ok(source.includes('formatCoarsePlace'), 'captureLocation 要带回区县级粗描述');
  // 超时必须包住兜底逻辑：兜底在 catch 里，不能把 reject 吞成悬挂。
  assert.ok(/catch \(error\) \{\s*const fallback = await readLastKnownPosition\(Location\);\s*if \(!fallback\) throw error;/.test(source),
    '当前点失败应先尝试兜底、失败再抛原错误');
});
