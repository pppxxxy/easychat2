# Requirements Document — 看屏幕悬浮窗（跨应用截屏 + 视频观屏）

## Introduction

将现有「看屏幕」从「只截本应用画面」升级为系统级悬浮小窗：悬浮球可展开为含截屏按钮与迷你对话的小窗口，再收起为圆形悬浮球；通过系统屏幕捕获授权获取**跨应用**屏幕画面，交给具备识图能力的多模态模型生成角色评论。在模型声明视频能力时，进一步支持以周期性帧序列实现「角色看着屏幕回答」。

> 现状：`src/screenWatch/` 用 `react-native-view-shot` 截本应用，零新增权限；本需求第一次引入**悬浮窗权限**与**系统屏幕捕获（MediaProjection）**，属本项目原生能力的重大扩展。

## Glossary

- **悬浮球**：常驻于其他应用之上的圆形系统级控件，由原生 `WindowManager`（`TYPE_APPLICATION_OVERLAY`）承载。
- **小窗口**：悬浮球展开后的面板，含「截屏」按钮与迷你对话区。
- **系统屏幕捕获**：Android `MediaProjection` 提供的跨应用屏幕画面获取能力，需用户在系统对话框中逐会话授权。
- **识图能力**：在线来源 `supportsVision` 或本地模型 `hasVision`（`getLocalModelMediaCapabilities(...).vision`）。
- **视频能力**：模型声明可接受视频/帧序列输入的能力标记（本项目当前无此字段，需新增）。

## Requirements

### Requirement 1 — 悬浮球与小窗口

**User Story:** AS 用户, I want 一个能随时截屏并和角色说话的小窗, so that 我在任何界面都能让角色看我的屏幕。

#### Acceptance Criteria

1. WHEN 用户在小窗内点按「收起」控件, the app SHALL 将小窗收缩为圆形悬浮球。
2. WHEN 用户点按悬浮球, the app SHALL 将悬浮球展开为包含「截屏」按钮与迷你对话区的小窗。
3. WHILE 小窗处于展开态, the app SHALL 支持拖动以改变其在屏幕上的位置。
4. WHEN 用户关闭悬浮窗功能, the app SHALL 移除悬浮视图并停止关联的前台服务。

### Requirement 2 — 权限申请与引导

**User Story:** AS 用户, I want 清楚知道为什么需要权限, so that 我能自主决定是否授予。

#### Acceptance Criteria

1. WHEN 用户首次开启悬浮窗功能, the app SHALL 解释该功能用途并引导用户前往系统「显示在其他应用上层」设置页。
2. WHEN 悬浮窗权限未授予, the app SHALL 保持悬浮窗关闭并展示权限未授予的提示。
3. WHEN 用户首次触发截屏而未授权屏幕捕获, the app SHALL 调起系统屏幕捕获授权对话框。
4. WHEN 用户拒绝屏幕捕获授权, the app SHALL 保持悬浮窗可用并提示需要屏幕捕获权限才能截屏。

### Requirement 3 — 跨应用截屏与角色观屏

**User Story:** AS 用户, I want 角色能看到别的应用画面并评论, so that 陪伴场景不局限于本应用。

#### Acceptance Criteria

1. WHEN 用户在已授权状态下点按「截屏」, the app SHALL 获取一张当前屏幕画面并保存到本机 `screen-watch/` 目录。
2. WHEN 截屏成功且当前模型具备识图能力, the app SHALL 将截图作为多模态图片输入发送并生成角色评论。
3. IF 当前模型不具备识图能力, the app SHALL 提示「需要支持识图的模型」并停止生成。
4. WHEN 系统屏幕捕获会话结束（用户停止、锁屏、或系统回收）, the app SHALL 停止捕获并释放相关资源。
5. WHEN 截屏文件累计超过保留数量, the app SHALL 依现有滚动清扫策略清理最旧文件。

### Requirement 4 — 视频观屏（实验）

**User Story:** AS 用户, I want 视频模型能连续看我的屏幕, so that 角色能对正在发生的事实时回应。

#### Acceptance Criteria

1. WHERE 模型声明视频能力, the app SHALL 以周期性采集的帧序列作为多模态输入，替代单帧输入。
2. WHERE 模型仅声明识图能力, the app SHALL 以单帧输入生成评论。
3. WHEN 视频观屏进行中且用户关闭小窗或锁屏, the app SHALL 停止帧采集。

### Requirement 5 — 生命周期、披露与不回归

**User Story:** AS 维护者/用户, I want 该能力可控、透明、不影响现有功能, so that 隐私与稳定性可控。

#### Acceptance Criteria

1. WHEN 悬浮窗功能关闭或应用进程结束, the app SHALL 停止前台服务并释放悬浮视图与屏幕捕获资源。
2. WHEN 截屏或帧序列用于评论, the `SECURITY.md` SHALL 披露「屏幕画面（含其他应用内容）会以多模态形式发送至所选模型」。
3. WHEN 悬浮窗功能处于关闭态, the app SHALL 保持现有「应用内截屏」入口与行为不变。

## 决策（2026-10-03 已定）

- **接受 MediaProjection 体验代价**：冷启动每次重新授权、状态栏常驻捕获提示、锁屏即停；另需悬浮窗权限（系统设置手动开启）。
- **「视频观屏」按周期截帧序列实现**：以固定间隔采集若干帧作为多模态输入，近似「连续看」；不引入真实视频编码/传输。OpenAI 兼容协议无标准视频输入，帧序列为可落地方案。
