// 位置（自写位置版）接线源码断言：面板切换、无定位权限、清单单选与增删改、
// 聊天注入、barrel 导出。
// （WebView 渲染与 Linking 依赖运行时，Node 进不去。）

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
  assert.ok(source.includes('<RealMapView />'), '真实模式渲染真实地图');
  // 网格地图关键路径保留
  assert.ok(source.includes('getWorldMap') && source.includes('updateWorldMap'), '网格存储读写不变');
  assert.ok(source.includes('MAP_GRID_SIZE') && source.includes('onGridPress'), '网格交互保留');
});

test('不再读取系统定位：无 expo-location 依赖、无权限声明、无取点链路', () => {
  const config = JSON.parse(read('app.json'));
  const plugins = config.expo.plugins || [];
  const hasLocationPlugin = plugins.some(entry => (
    entry === 'expo-location'
    || (Array.isArray(entry) && entry[0] === 'expo-location')
  ));
  assert.ok(!hasLocationPlugin, '不再声明 expo-location 插件（权限/用途文案随之下线）');
  const blocked = (config.expo.android && config.expo.android.blockedPermissions) || [];
  assert.ok(blocked.includes('android.permission.ACCESS_FINE_LOCATION'), '显式屏蔽定位权限（库清单里仍声明）');
  assert.ok(blocked.includes('android.permission.ACCESS_COARSE_LOCATION'));

  const view = read('src/worldMap/RealMapView.js');
  for (const forbidden of ['ensureLocationPermission', 'captureLocation', 'requestForegroundPermissions', 'expo-location']) {
    assert.ok(!view.includes(forbidden), `RealMapView 不得再引用 ${forbidden}`);
  }
  assert.ok(!fs.existsSync(path.resolve('src/location/service.js')), '取点模块已删除');
});

test('位置清单：单选、增删改、示例一次写入', () => {
  const source = read('src/worldMap/RealMapView.js');
  assert.ok(source.includes('resolveActivePlace'), '按选中项解析当前使用的位置');
  assert.ok(source.includes('activePlaceId: place.id'), '点一行即切换成它（一次只用一个）');
  assert.ok(source.includes('upsertPlace(current, {'), '新增/编辑走 upsertPlace');
  assert.ok(source.includes('removePlace(current, place.id)'), '删除走 removePlace');
  assert.ok(source.includes('PLACE_LIMIT'), '数量上限可见');
  assert.ok(source.includes('t(\'world.map.real.place.add\')'), '新增入口');
  assert.ok(source.includes('t(\'world.map.real.place.delete.title\')'), '删除有二次确认');
  // 示例只在首次写入（seeded 标记），删光后不再自动冒出来
  assert.ok(source.includes('loaded.seeded !== true && loaded.places.length === 0'), '首次进入才写示例');
  assert.ok(source.includes('seeded: true'), '写示例时打标记');
  const zh = read('src/i18n/locales/zh-CN.js');
  assert.ok(zh.includes("'world.map.real.example.qingdao': '山东青岛'"), '示例：山东青岛');
  assert.ok(zh.includes("'world.map.real.example.washington': '美国华盛顿'"), '示例：美国华盛顿');
  assert.ok(zh.includes("'world.map.real.example.hogwarts': '霍格沃茨魔法学院'"), '示例：霍格沃茨魔法学院');
  assert.ok(zh.includes('真实的或虚构的都行'), '说明可以随便写哪里');
});

test('地图标注：有坐标标（GCJ-02），没坐标清标记', () => {
  const source = read('src/worldMap/RealMapView.js');
  assert.ok(source.includes('wgs84ToGcj02'), '标注前转 GCJ-02（高德瓦片）');
  assert.ok(source.includes('__setMarker'), '有坐标注入标记');
  assert.ok(source.includes('__clearMarker'), '无坐标（虚构地点）清掉标记');
  const html = read('src/worldMap/realMapHtml.js');
  assert.ok(html.includes('window.__clearMarker'), '内联页面暴露 __clearMarker');
});

test('聊天注入：双开关门控 + 选中位置 + 手写位置不判龄', () => {
  const source = read('src/chat/useChatSend.js');
  assert.ok(source.includes('buildLocationText'), '复用纯函数组装位置行');
  assert.ok(source.includes('getLocationSettings'), '读取位置开关与清单');
  assert.ok(source.includes('placeToLocation(resolveActivePlace(locationSettings))'), '注入的是选中那条位置');
  assert.ok(source.includes('{ maxAgeMs: null }'), '手写位置没有取点时间，不按定位时效判过期');
  assert.ok(source.includes('locationText: locationLine'), '传给 buildRequestMessages');
  // 隐私门控：位置分享（enabled）与位置感知（awareness）都开启才注入——
  // 任意一边开都不行，去掉任一条件即回归。
  assert.ok(
    source.includes('locationSettings && locationSettings.enabled === true && locationSettings.awareness === true'),
    '注入条件必须是 enabled 与 awareness 的双与'
  );
});

test('barrel：storage.js 导出位置清单 API', () => {
  const source = read('src/storage.js');
  assert.ok(source.includes("from './storage/location.js'"), '位置存储域已挂到 barrel');
  assert.ok(source.includes('getLocationSettings') && source.includes('updateLocationSettings'));
  assert.ok(source.includes('upsertPlace') && source.includes('removePlace') && source.includes('PLACE_LIMIT'),
    '清单增删改与上限已导出');
  assert.ok(!source.includes('setLastLocation'), '真实定位写入入口已移除');
});

test('RealMapView：html 只依赖瓦片模板，换模板后必须回退 webReady 再注入', () => {
  const source = read('src/worldMap/RealMapView.js');
  const htmlMemo = source.slice(source.indexOf('const tileUrl'), source.indexOf('const inject'));
  assert.ok(htmlMemo.length > 0, '必须能定位到 html 的 useMemo');
  assert.ok(htmlMemo.includes('[tileUrl]'), 'html memo 依赖必须收窄到 tileUrl');
  assert.ok(!/\[settings\]/.test(htmlMemo),
    '不得以整个 settings 作为 html 依赖：选中/编辑每次变化都会重建 source → WebView 整页重载');
  assert.ok(/useEffect\(\(\) => \{\s*setWebReady\(false\);\s*\}, \[html\]\)/.test(source),
    'html 变化时必须先把 webReady 置回 false，等 onLoadEnd 后再向新文档注入标记');
  assert.ok(source.includes('onLoadEnd={() => setWebReady(true)}'), 'onLoadEnd 负责把 webReady 置回 true');
});

test('SettingsScreen：位置感知开关仅在位置分享开启时显示，写独立字段', () => {
  const source = read('src/SettingsScreen.js');
  assert.ok(source.includes("t('settings.location.awareness.title')"), '设置页有位置感知开关');
  assert.ok(source.includes('locationSettings.enabled === true'), '开关仅在位置分享开启时渲染');
  assert.ok(source.includes('updateLocationSettings(current => ({ ...current, awareness: value === true }))'),
    '开关写 @easychat2_location.awareness（独立 opt-in）');
  assert.ok(source.includes("t('settings.location.awareness.hint')"), '开关下方有隐私说明');
});
