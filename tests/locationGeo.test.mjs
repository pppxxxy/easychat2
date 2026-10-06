// 位置纯函数测试：坐标格式、WGS-84→GCJ-02 偏移、注入文本开关矩阵。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildLocationText,
  describeLocation,
  formatCoordinate,
  gcj02ToWgs84,
  isOutOfChina,
  placeToLocation,
  resolveActivePlace,
  wgs84ToGcj02,
} from '../src/location/geo.js';

test('placeToLocation：名称成为描述，坐标可缺省（虚构地点）', () => {
  const withCoords = placeToLocation({ name: '  山东青岛  ', latitude: 36.07, longitude: 120.38 });
  assert.equal(withCoords.description, '山东青岛');
  assert.equal(withCoords.coarse, '山东青岛', 'coarse 用同一条名称（注入优先取它）');
  assert.equal(withCoords.latitude, 36.07);
  assert.equal(withCoords.updatedAt, 0, '手写位置没有取点时间：注入侧用 maxAgeMs=null 关掉判龄');

  const fictional = placeToLocation({ name: '霍格沃茨魔法学院' });
  assert.equal(fictional.description, '霍格沃茨魔法学院');
  assert.equal(fictional.latitude, null, '没有坐标就是 null');

  assert.equal(placeToLocation(null), null);
  assert.equal(placeToLocation({ name: '   ' }), null, '无名称视为无效');
});

test('resolveActivePlace：返回选中项，失效时回落第一条', () => {
  const places = [{ id: 'a', name: '一' }, { id: 'b', name: '二' }];
  assert.equal(resolveActivePlace({ places, activePlaceId: 'b' }).name, '二');
  assert.equal(resolveActivePlace({ places, activePlaceId: 'gone' }).name, '一', '选中项失效回落第一条');
  assert.equal(resolveActivePlace({ places: [], activePlaceId: 'a' }), null);
  assert.equal(resolveActivePlace(null), null);
});

test('手写位置不判龄：maxAgeMs=null 时照常注入', () => {
  const line = buildLocationText(
    true,
    placeToLocation({ name: '霍格沃茨魔法学院' }),
    { maxAgeMs: null }
  );
  assert.equal(line, '[当前位置] 霍格沃茨魔法学院');
  // 有坐标也不带进注入文本（只分享名称）
  assert.equal(
    buildLocationText(true, placeToLocation({ name: '山东青岛', latitude: 36.07, longitude: 120.38 }), { maxAgeMs: null }),
    '[当前位置] 山东青岛'
  );
  assert.equal(buildLocationText(false, placeToLocation({ name: '山东青岛' }), { maxAgeMs: null }), '',
    '开关关掉 = 空串');
});

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

test('gcj02ToWgs84：境内反算回 WGS-84，与正向往返闭合；境外/非法原样返回', () => {
  // 图上标点拿到的 GCJ-02 必须能还原成 WGS-84，否则下次标注会叠加偏移。
  for (const [lat, lng] of [[39.9087, 116.3975], [31.2304, 121.4737], [23.1291, 113.2644], [43.8256, 87.6168]]) {
    const gcj = wgs84ToGcj02(lat, lng);
    const back = gcj02ToWgs84(gcj.latitude, gcj.longitude);
    assert.ok(Math.abs(back.latitude - lat) < 1e-6, `纬度往返闭合 ${lat}`);
    assert.ok(Math.abs(back.longitude - lng) < 1e-6, `经度往返闭合 ${lng}`);
  }

  // 反算必须真的偏移回来，不能是恒等。
  const gcj = wgs84ToGcj02(39.9087, 116.3975);
  const back = gcj02ToWgs84(gcj.latitude, gcj.longitude);
  assert.ok(Math.abs(back.latitude - gcj.latitude) > 0.0005, '确实做了反向偏移');

  assert.deepEqual(gcj02ToWgs84(35.68, 139.76), { latitude: 35.68, longitude: 139.76 }, '境外不偏移');
  const bad = gcj02ToWgs84(Number.NaN, 1);
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
