// 位置纯函数测试：坐标格式、WGS-84→GCJ-02 偏移、注入文本开关矩阵。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildLocationText,
  describeLocation,
  formatCoordinate,
  isOutOfChina,
  wgs84ToGcj02,
} from '../src/location/geo.js';

test('wgs84ToGcj02：境内产生偏移，境外/非法原样返回', () => {
  const beijing = wgs84ToGcj02(39.9087, 116.3975);
  assert.ok(Math.abs(beijing.latitude - 39.9087) > 0.0005, '境内纬度必须有偏移');
  assert.ok(Math.abs(beijing.longitude - 116.3975) > 0.0005, '境内经度必须有偏移');
  assert.ok(Math.abs(beijing.latitude - 39.9087) < 0.02, '偏移应在合理量级');
  assert.ok(Math.abs(beijing.longitude - 116.3975) < 0.02);

  assert.deepEqual(wgs84ToGcj02(35.68, 139.76), { latitude: 35.68, longitude: 139.76 }, '境外不偏移');
  const bad = wgs84ToGcj02(Number.NaN, 1);
  assert.ok(Number.isNaN(bad.latitude), '非法输入不抛错、原样返回');
});

test('isOutOfChina：国境内为 false，境外为 true', () => {
  assert.equal(isOutOfChina(39.9, 116.4), false);
  assert.equal(isOutOfChina(23.13, 113.26), false);
  assert.equal(isOutOfChina(35.68, 139.76), true);
  assert.equal(isOutOfChina(0, 0), true);
  assert.equal(isOutOfChina(Number.NaN, 116), true);
});

test('formatCoordinate 与 describeLocation', () => {
  assert.equal(formatCoordinate(39.9042, 116.4074), '39.904200, 116.407400');
  assert.equal(formatCoordinate(39.9042, 116.4074, 2), '39.90, 116.41');
  assert.equal(formatCoordinate(Number.NaN, 1), '');

  assert.equal(describeLocation({ latitude: 39.9, longitude: 116.4, description: '北京市东城区' }), '北京市东城区');
  assert.equal(describeLocation({ latitude: 39.9042, longitude: 116.4074 }), '39.904200, 116.407400');
  assert.equal(describeLocation({ latitude: 39.9, longitude: 116.4, description: '   ' }), '39.900000, 116.400000');
  assert.equal(describeLocation(null), '');
  assert.equal(describeLocation(undefined), '');
});

test('buildLocationText：开关与空位置矩阵', () => {
  const last = { latitude: 39.9042, longitude: 116.4074, description: '北京市东城区' };
  assert.equal(buildLocationText(true, last), '[当前位置] 北京市东城区');
  assert.equal(buildLocationText(true, { latitude: 1.5, longitude: 2.5 }), '[当前位置] 1.500000, 2.500000');
  assert.equal(buildLocationText(false, last), '', '关闭时不注入');
  assert.equal(buildLocationText(true, null), '', '无位置不注入');
  assert.equal(buildLocationText(true, { latitude: Number.NaN, longitude: Number.NaN }), '');
});
