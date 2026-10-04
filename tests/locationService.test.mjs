// 定位服务：超时包装的纯函数行为 + 取点调用必须真的走超时。
// （expo-location 本身在 Node 里跑不起来，这里只测可测的部分。）

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { LOCATION_TIMEOUT_MS, withTimeout } from '../src/location/service.js';

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
