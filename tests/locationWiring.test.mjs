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

test('聊天注入：useChatSend 读取位置设置并传 locationText，且双开关同时开启才注入', () => {
  const source = read('src/chat/useChatSend.js');
  assert.ok(source.includes('buildLocationText'), '复用纯函数组装位置行');
  assert.ok(source.includes('getLocationSettings'), '读取位置开关与最近位置');
  assert.ok(source.includes('locationText: locationLine'), '传给 buildRequestMessages');
  // 隐私门控：真实地图分享（enabled）与位置感知（awareness）都开启才注入——
  // 任意一边开都不行，去掉任一条件即回归。
  assert.ok(
    source.includes('locationSettings && locationSettings.enabled === true && locationSettings.awareness === true'),
    '注入条件必须是 enabled 与 awareness 的双与'
  );
});

test('barrel：storage.js 导出位置设置 API', () => {
  const source = read('src/storage.js');
  assert.ok(source.includes("from './storage/location.js'"), '位置存储域已挂到 barrel');
  assert.ok(source.includes('getLocationSettings') && source.includes('updateLocationSettings'));
  assert.ok(source.includes('setLastLocation'));
});

test('RealMapView：先授权取点成功才落盘 enabled，关闭时清除最近位置', () => {
  const source = read('src/worldMap/RealMapView.js');
  const enable = source.slice(source.indexOf('const handleEnable'), source.indexOf('const handleDisable'));
  const disable = source.slice(source.indexOf('const handleDisable'), source.indexOf('const handleRefresh'));
  assert.ok(enable.length > 0 && disable.length > 0, '必须能定位到开启/关闭处理体');

  const captureAt = enable.indexOf('await capture()');
  const persistAt = enable.indexOf('enabled: true');
  assert.ok(captureAt >= 0, '开启流程必须先走 capture()（含授权）');
  assert.ok(persistAt >= 0, '开启流程仍需落盘 enabled');
  assert.ok(captureAt < persistAt,
    '必须先授权取点、成功后才写 enabled —— 否则用户拒绝授权后开关在存储里仍是开');
  assert.ok(enable.includes('if (!ok) return;'),
    'capture 未成功时直接返回，不得继续写 enabled');

  assert.ok(/enabled:\s*false,\s*last:\s*null/.test(disable),
    '关闭开关时必须同时清除最近位置，避免旧位置留在盘上等待被注入');
});

test('RealMapView：取点前有隐私确认；服务关闭给可操作文案；未开位置感知给提示', () => {
  const source = read('src/worldMap/RealMapView.js');
  assert.ok(source.includes("t('world.map.real.privacy.title')"), '开启前必须弹隐私提醒');
  assert.ok(source.includes("t('world.map.real.privacy.body')"), '隐私提醒必须有正文');
  assert.ok(source.includes("t('world.map.real.privacy.hint')"), '引导页必须有常驻隐私提示行');
  // 隐私确认必须发生在取点之前：取消 = 不取点、不写 enabled。
  const enable = source.slice(source.indexOf('const handleEnable'), source.indexOf('const handleDisable'));
  const confirmAt = enable.indexOf('await confirmPrivacy()');
  const captureAt = enable.indexOf('await capture()');
  assert.ok(confirmAt >= 0 && captureAt >= 0 && confirmAt < captureAt, '先确认隐私、后取点');
  assert.ok(enable.includes('if (!confirmed) return;'), '取消确认必须直接返回');
  // 服务关闭 → 专属文案（而非笼统失败）。
  assert.ok(source.includes("caught.code === 'SERVICES_DISABLED'"), '按错误码分流文案');
  assert.ok(source.includes("t('world.map.real.servicesOff')"), '服务关闭文案存在');
  assert.ok(source.includes("t('world.map.real.awarenessOff')"), '未开位置感知时的提示行存在');
});

test('SettingsScreen：位置感知开关仅在真实地图开启时显示，写独立字段', () => {
  const source = read('src/SettingsScreen.js');
  assert.ok(source.includes("t('settings.location.awareness.title')"), '设置页有位置感知开关');
  assert.ok(source.includes('locationSettings.enabled === true'), '开关仅在真实地图开启时渲染');
  assert.ok(source.includes("updateLocationSettings(current => ({ ...current, awareness: value === true }))"),
    '开关写 @easychat2_location.awareness（独立 opt-in）');
  assert.ok(source.includes("t('settings.location.awareness.hint')"), '开关下方有隐私说明');
});

test('RealMapView：html 只依赖瓦片模板，换模板后必须回退 webReady 再注入', () => {
  const source = read('src/worldMap/RealMapView.js');
  const htmlMemo = source.slice(source.indexOf('const tileUrl'), source.indexOf('const inject'));
  assert.ok(htmlMemo.length > 0, '必须能定位到 html 的 useMemo');
  assert.ok(htmlMemo.includes('[tileUrl]'), 'html memo 依赖必须收窄到 tileUrl');
  assert.ok(!/\[settings\]/.test(htmlMemo),
    '不得以整个 settings 作为 html 依赖：开关/位置每次变化都会重建 source → WebView 整页重载');
  assert.ok(/useEffect\(\(\) => \{\s*setWebReady\(false\);\s*\}, \[html\]\)/.test(source),
    'html 变化时必须先把 webReady 置回 false，等 onLoadEnd 后再向新文档注入标记');
  assert.ok(source.includes('onLoadEnd={() => setWebReady(true)}'), 'onLoadEnd 负责把 webReady 置回 true');
});
