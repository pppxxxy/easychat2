# Requirements Document — 真实地图与用户位置

## Introduction

现有「地图」是 40×40 的抽象网格安家玩法（见现状截图）。本需求新增「真实地图」能力：在用户授权定位后，获取用户真实位置并标注在可缩放/平移的真实地图上；同时让角色「知道」用户当下所在的真实位置，用于对话与陪伴场景。

## Glossary

- **定位权限**：Android `ACCESS_COARSE_LOCATION`/`ACCESS_FINE_LOCATION`（前台，仅在使用中获取）。
- **真实地图**：以瓦片底图渲染的真实地理地图（区别于现有抽象网格地图）。
- **反地理编码**：将经纬度转换为可读地点描述（城市/区/街道）的过程。
- **位置上下文**：注入到模型请求中的、由当前位置描述构成的一行文本。
- **网格地图**：现有 `src/worldMap` 的抽象安家地图，本需求保持其存在。

## Requirements

### Requirement 1 — 定位授权

**User Story:** AS 用户, I want 自主决定是否让应用知道我的位置, so that 隐私可控。

#### Acceptance Criteria

1. WHEN 用户首次开启「真实位置」功能, the app SHALL 解释用途并请求前台定位权限。
2. WHEN 用户拒绝定位权限, the app SHALL 保持该功能关闭并展示权限未授予的提示。
3. WHEN 用户关闭「真实位置」功能, the app SHALL 停止获取位置并清除界面上的实时位置标注。

### Requirement 2 — 位置获取与反地理编码

**User Story:** AS 用户, I want 应用把我的真实位置转成可读地点, so that 角色能理解我在哪。

#### Acceptance Criteria

1. WHEN 权限已授予且用户开启该功能, the app SHALL 获取一次当前经纬度。
2. WHEN 经纬度获取成功, the app SHALL 通过反地理编码得到可读地点描述；IF 反地理编码失败, the app SHALL 退回展示经纬度并继续提供可用功能。
3. WHEN 用户主动刷新, the app SHALL 重新获取并更新当前位置。
4. IF 定位获取失败或超时, the app SHALL 提示失败原因并保留上一次成功的位置（若存在）。

### Requirement 3 — 真实地图展示

**User Story:** AS 用户, I want 在真实地图上看到自己的位置, so that 我能直观确认角色知道的地点。

#### Acceptance Criteria

1. WHEN 用户打开真实地图且已获得位置, the app SHALL 在可缩放、可平移的地图上标注当前位置。
2. WHEN 用户尚未授权或未获取到位置, the app SHALL 展示引导获取位置的占位视图。
3. WHEN 真实地图与网格地图并存, the app SHALL 在同一入口内提供两种地图的切换，且网格地图行为保持不变。

### Requirement 4 — 角色知情（位置上下文）

**User Story:** AS 用户, I want 角色知道我现在的真实方位, so that 对话能结合我的处境。

#### Acceptance Criteria

1. WHERE 「真实位置」功能已开启且存在最近一次成功的位置, the app SHALL 在请求上下文中注入一行位置描述。
2. WHEN 位置功能处于关闭态, the app SHALL 保持请求上下文与现状一致（不含位置描述）。
3. WHEN 位置描述被注入, the app SHALL 采用与「时间感知」一致的措辞风格与位置（系统提示前部）。

### Requirement 5 — 披露与不回归

**User Story:** AS 维护者, I want 位置用途透明且不影响既有功能, so that 隐私合规与稳定性可控。

#### Acceptance Criteria

1. WHEN 位置功能使用, the `SECURITY.md` SHALL 披露「当前位置（含反地理编码结果）会随消息发送至所选模型」。
2. WHEN 位置功能全程未开启, the app SHALL 不获取任何位置数据。
3. WHEN 引入真实地图, the app SHALL 保持现有网格地图、安家玩法与其存储键不变。

## 决策（2026-10-03 已定）

- **真实地图渲染**：采用 **WebView + 国内可访问的栅格瓦片**（默认高德栅格瓦片；瓦片 URL 可配置以便日后切换官方 Key 方案），**不使用 Google 地图**。复用已有 `react-native-webview`，不引入原生地图 SDK。
- **反地理编码**：优先 `expo-location` 的平台反地理编码；`IF` 返回为空或失败，`SHALL` 退回展示经纬度并保持功能可用（国内无 Google 服务时平台地理编码可能不可用）。
- **位置作用域**：**全局开关**。开启且存在最近一次成功位置时，在请求上下文注入一行位置描述（与「时间感知」同款，位于系统提示前部）。
