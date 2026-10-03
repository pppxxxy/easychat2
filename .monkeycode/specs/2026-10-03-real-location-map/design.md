# Technical Design — 真实地图与用户位置

## Overview

在现有「世界 → 地图」面板内，与 40×40 抽象网格地图并存一个**真实地图**视图：WebView + 国内栅格瓦片（默认高德）渲染，标注用户当前经纬度。定位经 `expo-location` 获取并反地理编码为可读地点；开启「真实位置」后，普通聊天请求的系统提示前部注入一行 `[当前位置] ...`，与「时间感知」同款。网格地图、安家玩法及其存储键完全不变。

## Architecture

```
地图面板 (MapPanel.js)
  ├─ 网格地图（既有，不改行为）
  └─ 真实地图模式（新增）
       ├─ RealMapView.js        RN 壳：WebView + 定位/刷新/开关按钮
       │    └─ realMapHtml.js   内联 slippy map（纯字符串，无外部 CDN 依赖）
       ├─ location/service.js   expo-location 权限/取点/反地理编码（RN）
       └─ storage/location.js   @easychat2_location 持久化

聊天上下文
  useChatSend.js → location/geo.js buildLocationText() → chatPipeline.js（系统提示前部）
```

要点：
- **不引入原生地图 SDK**，复用已有 `react-native-webview`；瓦片地图逻辑内联在 HTML 字符串里，不依赖 CDN（国内网络可达性可控）。
- **不修改 `@easychat2_world_map`**；位置数据落在新键 `@easychat2_location`。
- 反地理编码优先 `expo-location` 平台能力；失败退回经纬度文本，功能仍可用。

## Data Model

### `@easychat2_location`

```json
{
  "enabled": false,
  "last": {
    "latitude": 39.9042,
    "longitude": 116.4074,
    "description": "北京市东城区…",
    "updatedAt": 1760000000000
  },
  "tileUrl": ""
}
```

- `enabled`：全局开关。关闭时**不取点、不注入**（Req 1.3 / 5.2）。
- `last`：最近一次成功位置（WGS-84）。`description` 可为空（反地理编码失败），展示/注入时退回坐标。
- `tileUrl`：可选瓦片模板覆盖；空 = 默认高德栅格模板（`{s}`/`{x}`/`{y}`/`{z}` 占位）。

归一化：`last` 经纬度非法（NaN 或同时为 0）→ `null`；损坏读取先 `backupCorruptValue` 再回落默认，避免覆盖。

## Module Design

### `src/location/geo.js`（纯函数，Node 直测）

- `isOutOfChina(lat, lng)`：境外判定（用于决定是否做 WGS→GCJ 偏移）。
- `wgs84ToGcj02(lat, lng)`：WGS-84 → GCJ-02（火星坐标）。境外或非法输入原样返回。默认高德瓦片为 GCJ-02，标注前必须转换，否则国内有数百米偏移。
- `formatCoordinate(lat, lng, digits=6)`：`"39.904200, 116.407400"`。
- `describeLocation(last)`：`description` 非空用描述，否则用坐标。
- `buildLocationText(enabled, last)`：`[当前位置] <describe>`；未开启或无位置返回 `''`（保证关闭态上下文与现状一致，Req 4.2）。

### `src/storage/location.js`（存储领域）

`getLocationSettings()` / `saveLocationSettings(settings)` / `updateLocationSettings(updater)` / `setLastLocation(location)`，迁移队列串行、损坏备份，风格同 `storage/worldMap.js`；经 `src/storage.js` barrel 导出。

### `src/location/service.js`（RN，expo-location）

- `ensureLocationPermission()`：`requestForegroundPermissionsAsync`，返回是否授予（Req 1）。
- `captureLocation({ timeoutMs })`：`getCurrentPositionAsync`（平衡精度）+ `reverseGeocodeAsync` 兜底；返回 `{ latitude, longitude, description, updatedAt }`；失败抛错由 UI 提示并保留旧位置（Req 2）。
- 惰性 `require('expo-location')`，缺失时抛可读错误（与 `localApiServer` 同风格）。

### `src/worldMap/realMapHtml.js`（纯字符串）

`buildRealMapHtml({ tileUrl, subdomains })` 返回完整 HTML：
- Web Mercator 投影，tile=256px；按视口计算覆盖瓦片并以绝对定位 `<img>` 拼贴；`{s}` 按 `(x+y)%subdomains.length` 轮询子域。
- 支持单指拖动平移、双指捏合缩放、`+/-/◎` 按钮；`◎` 回中到标记。
- 暴露 `window.__setView(lat,lng,z)`、`window.__setMarker(lat,lng)`、`window.__setTile(url,subs)` 供 RN `injectJavaScript` 调用。
- 右下角标注「地图数据 © 高德」。深色主题配色。

### `src/worldMap/RealMapView.js`（RN UI）

- 顶部：实时位置描述 + 「刷新」「开启/关闭」。
- 开关打开：`ensureLocationPermission` → 失败提示并保持关闭；成功 `captureLocation` 并 `setLastLocation`。
- WebView 加载 `buildRealMapHtml()`；`onLoadEnd` 注入 `__setTile` 与 `__setMarker`（坐标先 `wgs84ToGcj02`）。
- 未开启/无位置：占位引导（解释用途 + 开启按钮），Req 3.2。

### `MapPanel.js`

标题行下加「网格 / 真实」分段选择；`真实` 渲染 `RealMapView`，`网格` 保持既有全部行为（Req 3.3 / 5.3）。

### 上下文注入

- `chatPipeline.buildRequestMessages` 新增 `locationText` 形参；非空时 `systemContent = locationText + "\n\n" + systemContent`，与时间行同区（Req 4.3）。
- `useChatSend.js` 单聊路径读取 `getLocationSettings()`，`locationText: buildLocationText(enabled, last)`。群聊与书籍/音乐/看屏幕陪伴评论不注入（与既有「时间感知」作用域一致）。主动消息的 `requestJson` 在保存时固化，注入会过期，故本期不注入（记为后续项）。

## Security & Privacy

- 权限仅前台（`WhenInUse`）；关闭开关即停止取点并清除实时标注（`last` 保留但不展示/不注入，除非重新开启——见下）。
- `SECURITY.md` 增补披露：开启后「当前位置（含反地理编码结果）」会随消息发送至所选模型。
- 瓦片请求直接由 WebView 发往瓦片服务商，不经过模型端点；URL 可配置。

## Testing

- `tests/locationGeo.test.mjs`：境外判定、WGS→GCJ 已知点偏移、坐标格式化、`buildLocationText` 开/关/空位置矩阵。
- `tests/locationStorage.test.mjs`：归一化（非法坐标→null）、开关读写、`last` 往返（Babel CJS 加载 storage 子模块，参照既有 `*Storage` 测试）。
- `tests/realMapHtml.test.mjs`：默认模板含高德域名与 `{z}/{x}/{y}` 占位、`{s}` 子域、注入 API 名存在。
- `tests/locationContext.test.mjs`（或并入 geo）：`buildRequestMessages` 传入 `locationText` 时出现在系统提示最前。
- 源码断言：`MapPanel` 含网格/真实切换且未改 `getWorldMap`；`app.json` 含 `expo-location` 插件；`useChatSend` 读取位置设置。

## Rollout / Compatibility

- 旧安装无 `@easychat2_location` → 默认关闭，行为与现状完全一致。
- 新增原生依赖 `expo-location` + 权限，需重新 prebuild/打包。
- 新增纯模块纳入 `.c8rc.json` 统计；`service.js` / `RealMapView.js` 为 RN 层，登记排除。
