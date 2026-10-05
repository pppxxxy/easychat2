// 真实地图 HTML 构造测试：默认高德瓦片、{s} 子域、注入 API、自定义模板回落。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_TILE_SUBDOMAINS,
  DEFAULT_TILE_URL,
  buildRealMapHtml,
} from '../src/worldMap/realMapHtml.js';

test('默认模板：含高德瓦片与全部占位符，暴露注入 API', () => {
  assert.ok(DEFAULT_TILE_URL.includes('autonavi'));
  assert.deepEqual(DEFAULT_TILE_SUBDOMAINS, ['1', '2', '3', '4']);

  const html = buildRealMapHtml();
  assert.ok(html.includes('autonavi'), '默认使用高德瓦片');
  assert.ok(html.includes('{x}') && html.includes('{y}') && html.includes('{z}') && html.includes('{s}'),
    '瓦片占位符齐全');
  assert.ok(html.includes('__setMarkers') && html.includes('__setTile') && html.includes('__setView'),
    'RN 注入 API 齐全');
  assert.ok(html.includes('__setMarking'), '标点模式开关 API 存在');
  assert.ok(html.includes('地图数据'), '署名保留');
});

test('标点：点图把 GCJ-02 坐标 postMessage 回 RN，且拖图/双指不误触发', () => {
  const html = buildRealMapHtml();
  // 回传协议：JSON + map-tap，RN 侧按 payload.type 过滤。
  assert.ok(html.includes('postMessage'), '用 postMessage 回传');
  assert.ok(html.includes("type: 'map-tap'"), '回传类型为 map-tap');
  assert.ok(html.includes('ReactNativeWebView'), '走 ReactNativeWebView 桥');
  // 只有标点模式才回传，且点击位移阈值判定避免拖图误落点。
  assert.ok(html.includes('if (!marking) return;'), '非标点模式不回传');
  assert.ok(html.includes('Math.abs(x - downX) <= 8'), '位移阈值判定');
  assert.ok(html.includes('multiTouch'), '双指缩放不误触发标点');
  // 多点标注：容器化渲染而非单点。
  assert.ok(html.includes('id="markers"'), '多点容器存在');
  assert.ok(!html.includes('__setMarker('), '旧单点 API 已移除');
});

test('自定义模板与子域以 JSON 注入', () => {
  const html = buildRealMapHtml({
    tileUrl: 'https://tile.example/{z}/{x}/{y}.png?s={s}',
    subdomains: ['a', 'b'],
  });
  assert.ok(html.includes('https://tile.example/{z}/{x}/{y}.png?s={s}'));
  assert.ok(html.includes('["a","b"]'), '子域数组序列化注入');
});

test('空白模板回落默认高德', () => {
  assert.ok(buildRealMapHtml({ tileUrl: '   ' }).includes('autonavi'));
  assert.ok(buildRealMapHtml({ subdomains: [] }).includes('autonavi'));
});
