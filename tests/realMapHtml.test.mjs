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
  assert.ok(html.includes('__setMarker') && html.includes('__setTile') && html.includes('__setView'),
    'RN 注入 API 齐全');
  assert.ok(html.includes('地图数据'), '署名保留');
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
