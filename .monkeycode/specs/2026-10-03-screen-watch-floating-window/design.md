# Technical Design — 看屏幕悬浮窗（跨应用截屏 + 视频观屏）

## Overview

在「世界 → 看屏幕」现有 App 内截图基础上，新增**系统级悬浮小窗**：悬浮球 ⇄ 小窗，经 `WindowManager`（`TYPE_APPLICATION_OVERLAY`）常驻于其他应用之上；通过 `MediaProjection` 获取**跨应用**屏幕画面，交由 JS 侧沿用既有 `useScreenWatchComments` 走多模态评论。模型声明视频能力时以周期帧序列近似「连续看」。App 内截图入口与行为保持不变。

## Architecture

```
native (plugins/screenOverlay/android/, com.pppxxxy.easychat2.screenoverlay)
  ScreenOverlayModule.kt   RN 桥：权限查询/申请、开始/停止悬浮窗、请求截屏、更新小窗文案、事件
  OverlayService.kt        前台服务 + WindowManager 悬浮视图（球/窗/拖动）+ MediaProjection 采集
  ScreenOverlayPackage.kt  ReactPackage
plugins/withScreenOverlay.js  权限、service 声明、Kotlin 拷贝、MainApplication 注册

JS (src/screenWatch/)
  overlay.js          原生桥薄封装（惰性 NativeModules + DeviceEventEmitter）
  ScreenWatchScreen.js 新增「悬浮窗」卡片：开关、引导、监听截屏事件 → 复用 useScreenWatchComments 生成 → 回写小窗
```

要点：
- 悬浮窗 UI 用原生 Android View（RN 无法渲染进 WindowManager 覆盖窗）。
- 采集用 `ImageReader` + `VirtualDisplay`，保存 PNG 到 `context.filesDir/screen-watch/`（与 expo `documentDirectory` 同目录），返回 `file://` URI。
- AI 评论仍在 JS：原生只负责采集与展示，事件把截图路径交给 JS。
- 关闭开关 / `onDestroy` / 锁屏（`MediaProjection.Callback.onStop`）→ 释放 VirtualDisplay/ImageReader/Projection、移除悬浮视图、停前台服务。

## Native contracts

### `ScreenOverlayModule` (name: `ScreenOverlay`)

| @ReactMethod | 说明 |
|--------------|------|
| `canDrawOverlays()` → Boolean | `Settings.canDrawOverlays` |
| `requestOverlayPermission()` → Boolean | 打开 `ACTION_MANAGE_OVERLAY_PERMISSION` |
| `requestCapturePermission()` → Promise<Boolean> | `startActivityForResult(MediaProjectionManager.createScreenCaptureIntent())`，`onActivityResult` 存 `resultCode`/`data` 后 resolve |
| `startOverlay()` → Promise<Boolean> | 有悬浮窗权限且已有捕获授权则启动 `OverlayService`（前台、`mediaProjection` 类型） |
| `stopOverlay()` → Promise<Boolean> | 停服务 |
| `isOverlayActive()` → Boolean | 服务存活 |
| `capture()` → Promise<Boolean> | 请求服务抓一帧；结果经事件回传 |
| `updateOverlayText(text)` → Boolean | 更新小窗内迷你文案（角色评论） |

事件（`DeviceEventEmitter`）：
- `ScreenOverlay:onCapture` `{ path }`：抓到一帧（file:// URI）。
- `ScreenOverlay:onRequestCapture`：用户在小窗点「截屏」→ JS 决定是否走视频帧序列。
- `ScreenOverlay:onState` `{ active }`：服务启停。

### `OverlayService`

- 前台通知（渠道 `screen_overlay`，低打扰）。
- 视图：圆形悬浮球（点击展开）↔ 小窗（标题、迷你文案 `TextView`、`截屏`、`收起`、`关闭`）。
- 拖动：`OnTouchListener` 更新 `LayoutParams.x/y`（区分点击与拖动阈值）。
- 采集：`registerCallback` 必须在 `createVirtualDisplay` 之前（Android 14 要求）；`maxImages=2`，常驻监听 `acquireLatestImage`→`close`，仅捕捉请求时转 Bitmap 落盘并发事件。
- `onDestroy` 幂等释放。

## JS design

- `overlay.js`：`isOverlaySupported/canDrawOverlays/requestOverlayPermission/requestCapturePermission/startOverlay/stopOverlay/isOverlayActive/capture/updateOverlayText`，并用 `DeviceEventEmitter` 暴露 `addCaptureListener/addRequestCaptureListener/addStateListener`。
- `ScreenWatchScreen`：
  - 新「悬浮窗」卡片：说明用途 → 「开启」流程 = 申请悬浮窗权限（未授予引导系统设置）→ 申请屏幕捕获 → `startOverlay`。
  - 监听 `onRequestCapture`：识图门控校验（复用现有口径）→ 捕获一帧（`capture` 后等 `onCapture`）→ `generate({ imageUri })` → 成功后 `updateOverlayText(评论)`。
  - 视频能力（`config.supportsVideo === true`）：捕获 4 帧（间隔 ~1.2s）并作为多图输入生成；否则单帧。
  - 关闭：`stopOverlay`。
- 单帧复用 `useScreenWatchComments.generate`；多帧走其内部 `images` 数组（`buildRequestMessages` 已支持多图）。

## Permissions / manifest

- `SYSTEM_ALERT_WINDOW`（悬浮窗，用户到系统设置手动授予）。
- `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_MEDIA_PROJECTION`。
- `<service android:name=".screenoverlay.OverlayService" android:exported="false" android:foregroundServiceType="mediaProjection" />`。
- App 内既有 `react-native-view-shot` 截图路径不变（Req 5.3）。

## Security & Privacy

- `SECURITY.md` 披露：开启悬浮窗后，**屏幕画面（含其他应用内容）**会以多模态发送至所选模型；采集仅在前台服务存活期间进行，锁屏/关闭即停。
- 截图落 `documentDirectory/screen-watch/`，沿用既有滚动保留 20 张策略、不进备份。

## Testing

- `tests/screenOverlayPlugin.test.mjs`：插件的纯函数（权限、service 声明、Gradle/MainApplication 补丁幂等）——镜像 `proactiveMessagePlugin` 测试。
- `tests/screenOverlayBridge.test.mjs`：`overlay.js` 的纯归一/事件名常量与源码接线（原生运行时 Node 进不去）。
- 覆盖率：`src/screenWatch/overlay.js` 与插件为 RN/构建层，`.c8rc.json` 登记排除；不放行后缀通配。

## Rollout

- 旧安装无该能力：`NativeModules.ScreenOverlay` 为空 → 卡片显示「当前构建不支持」并隐藏开关；App 内截图不受影响。
- 新增原生依赖与权限，需重新 prebuild/打包；`SYSTEM_ALERT_WINDOW` 原被模板默认引入，本功能正式使用（不再排除）。
