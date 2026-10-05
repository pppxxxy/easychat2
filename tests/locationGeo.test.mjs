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

test('buildLocationText：开关、空位置与位置年龄矩阵', () => {
  const now = 1_700_000_000_000;
  const fresh = { latitude: 39.9042, longitude: 116.4074, description: '北京市东城区', updatedAt: now - 60_000 };
  assert.equal(buildLocationText(true, fresh, { now }), '[当前位置] 北京市东城区', '默认 30 分钟内的新位置照常注入');
  // 坐标兜底走模糊精度（2 位小数 ≈ 1.1km）：精确坐标只留在本地地图上。
  assert.equal(buildLocationText(true, { latitude: 1.5, longitude: 2.5, updatedAt: now }, { now }), '[当前位置] 1.50, 2.50');
  assert.equal(buildLocationText(false, fresh, { now }), '', '关闭时不注入');
  assert.equal(buildLocationText(true, null, { now }), '', '无位置不注入');
  assert.equal(buildLocationText(true, { latitude: Number.NaN, longitude: Number.NaN, updatedAt: now }, { now }), '');
});

test('buildLocationText：注入优先用区县级 coarse，模糊优先于全量描述', () => {
  const now = 1_700_000_000_000;
  const withCoarse = {
    latitude: 39.9042,
    longitude: 116.4074,
    description: '北京市东城区景山街道某小区',
    coarse: '北京市东城区',
    updatedAt: now - 60_000,
  };
  assert.equal(buildLocationText(true, withCoarse, { now }), '[当前位置] 北京市东城区',
    '有 coarse 时必须用粗描述（不带街道/名称）');
  const legacy = { ...withCoarse, coarse: '' };
  assert.equal(buildLocationText(true, legacy, { now }), '[当前位置] 北京市东城区景山街道某小区',
    '旧数据没有 coarse 时退全量描述（升级前已存的位置）');
  const blank = { ...withCoarse, coarse: '   ', description: '  ' };
  assert.equal(buildLocationText(true, blank, { now }), '[当前位置] 39.90, 116.41',
    'coarse/描述都空时退模糊坐标');
});

test('buildLocationText：过期/无时间戳的位置不注入（宁缺毋错）', () => {
  const now = 1_700_000_000_000;
  const at = ms => ({ latitude: 39.9042, longitude: 116.4074, description: '北京市东城区', updatedAt: now - ms });
  assert.equal(buildLocationText(true, at(31 * 60_000), { now }), '', '默认上限 30 分钟，超龄不注入');
  assert.equal(buildLocationText(true, at(29 * 60_000), { now }), '[当前位置] 北京市东城区', '上限边缘内照常注入');
  assert.equal(buildLocationText(true, at(60_000), { now, maxAgeMs: 30_000 }), '', '上限可调');
  assert.equal(buildLocationText(true, at(60_000), { now, maxAgeMs: null }), '[当前位置] 北京市东城区', '显式不限龄可用');
  assert.equal(buildLocationText(true, { latitude: 1.5, longitude: 2.5 }, { now }), '', '缺 updatedAt 无法判龄 → 视为过期');
  assert.equal(buildLocationText(true, { latitude: 1.5, longitude: 2.5, updatedAt: 0 }, { now }), '', 'updatedAt=0 视为过期');
});
