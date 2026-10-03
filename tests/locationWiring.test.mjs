// 真实位置接线源码断言：面板切换、原生权限插件、聊天注入、barrel 导出。
// （WebView 渲染与 expo-location 依赖运行时，Node 进不去。）

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function read(relativePath) {
  return fs.readFileSync(path.resolve(relativePath), 'utf8');
}

test('MapPanel：网格/真实切换并存，网格行为不回归', () => {
  const source = read('src/MapPanel.js');
  assert.ok(source.includes("import RealMapView from './worldMap/RealMapView.js'"), '引入真实地图视图');
  assert.ok(source.includes("t('world.map.tab.grid')") && source.includes("t('world.map.tab.real')"), '两种地图切换');
  assert.ok(source.includes("<RealMapView />"), '真实模式渲染真实地图');
  // 网格地图关键路径保留
  assert.ok(source.includes('getWorldMap') && source.includes('updateWorldMap'), '网格存储读写不变');
  assert.ok(source.includes('MAP_GRID_SIZE') && source.includes('onGridPress'), '网格交互保留');
});

test('app.json：声明 expo-location 插件（权限/用途文案）', () => {
  const config = JSON.parse(read('app.json'));
  const plugins = config.expo.plugins || [];
  const hasLocation = plugins.some(entry => (
    entry === 'expo-location'
    || (Array.isArray(entry) && entry[0] === 'expo-location')
  ));
  assert.ok(hasLocation, '需加入 expo-location 配置插件');
  const locationEntry = plugins.find(entry => Array.isArray(entry) && entry[0] === 'expo-location');
  assert.ok(locationEntry && locationEntry[1] && locationEntry[1].locationWhenInUsePermission,
    '需提供前台定位用途文案');
});

test('聊天注入：useChatSend 读取位置设置并传 locationText', () => {
  const source = read('src/chat/useChatSend.js');
  assert.ok(source.includes('buildLocationText'), '复用纯函数组装位置行');
  assert.ok(source.includes('getLocationSettings'), '读取位置开关与最近位置');
  assert.ok(source.includes('locationText: locationLine'), '传给 buildRequestMessages');
});

test('barrel：storage.js 导出位置设置 API', () => {
  const source = read('src/storage.js');
  assert.ok(source.includes("from './storage/location.js'"), '位置存储域已挂到 barrel');
  assert.ok(source.includes('getLocationSettings') && source.includes('updateLocationSettings'));
  assert.ok(source.includes('setLastLocation'));
});
