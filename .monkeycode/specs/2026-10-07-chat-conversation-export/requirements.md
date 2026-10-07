# 对话导出为长图 / 分享卡片 需求文档

Feature Name: chat-conversation-export
Updated: 2026-10-07

## Introduction

聊天记录目前只能整体导出为 JSON 备份（面向迁移/恢复），没有「晒聊天记录」或存档成人类可读格式的出口。本功能在聊天页「⋯」菜单增加「导出对话」，支持把当前会话导出为：带气泡样式的长图（本地渲染 + 截图分享）、Markdown、HTML。全部本地完成，不依赖服务器，符合无后端定位。

## Glossary

- **导出**：把当前会话消息转换为长图 / Markdown / HTML 文件。
- **分享卡片**：带角色头像、气泡样式与时间戳的长图，用于「晒聊天记录」。
- **长图**：由离屏渲染的会话视图经 `react-native-view-shot` 捕获而成的单张 PNG。
- **可导出消息**：role 为 user/assistant、非 pending、非瞬态的消息。
- **分享**：调用系统分享面板（`expo-sharing`）把生成的文件交给其它 App；本功能不生成 URL。

## Requirements

### Requirement 1 导出入口

**User Story:** AS 用户，I want 在聊天页方便地找到导出入口，so that 我能快速把对话导出。

#### Acceptance Criteria

1. WHILE 处于聊天页，系统 SHALL 在「⋯」菜单提供「导出对话」入口。
2. WHEN 用户点击「导出对话」，系统 SHALL 打开导出面板，列出可选导出格式（长图 / Markdown / HTML）。
3. IF 当前会话没有可导出消息，系统 SHALL 禁用导出或提示无内容，不生成空文件。

### Requirement 2 导出为长图（分享卡片）

**User Story:** AS 用户，I want 把对话导出成带气泡样式的长图，so that 我能直接分享给别人看。

#### Acceptance Criteria

1. WHEN 用户选择导出长图，系统 SHALL 本地渲染一张包含当前会话可导出消息的分享卡片。
2. WHILE 渲染分享卡片，系统 SHALL 展示角色/会话名称、每条消息的说话人与正文，并区分用户与角色气泡。
3. WHEN 分享卡片渲染完成，系统 SHALL 通过系统分享面板分享该 PNG 文件。
4. IF 会话消息数量超过长图上限，系统 SHALL 只导出最近 N 条并在结果中提示已截断，避免生成超长图导致内存问题。
5. IF 渲染或分享失败，系统 SHALL 提示失败原因且不留下半成品文件。

### Requirement 3 导出为 Markdown

**User Story:** AS 用户，I want 把对话导出为 Markdown，so that 我能长期存档或在笔记软件里阅读。

#### Acceptance Criteria

1. WHEN 用户选择导出 Markdown，系统 SHALL 生成一个 `.md` 文件，包含会话标题、导出时间与逐条消息。
2. WHILE 生成 Markdown，系统 SHALL 用可读格式标注说话人，并把助手富文本消息转为纯文本。
3. WHEN 生成完成，系统 SHALL 通过系统分享面板分享该文件。

### Requirement 4 导出为 HTML

**User Story:** AS 用户，I want 把对话导出为 HTML，so that 我能在浏览器里还原气泡排版。

#### Acceptance Criteria

1. WHEN 用户选择导出 HTML，系统 SHALL 生成一个自包含的 `.html` 文件，含内联样式与气泡排版。
2. WHILE 生成 HTML，系统 SHALL 对消息正文做 HTML 转义，避免消息内容破坏文档结构。
3. WHEN 生成完成，系统 SHALL 通过系统分享面板分享该文件。

### Requirement 5 内容与安全

**User Story:** AS 维护者，I want 导出内容准确且不泄漏密钥，so that 功能安全可靠。

#### Acceptance Criteria

1. WHILE 导出，系统 SHALL 排除生成中的占位消息（pending）与瞬态消息。
2. WHILE 导出，系统 SHALL 仅导出当前会话的消息，不混入其它会话。
3. WHILE 导出文本格式，系统 SHALL 把图片/表情包/语音消息表示为可读占位（如 `[图片]`、`[表情包：名称]`、`[语音]`）。
4. WHEN 导出内容包含疑似密钥文本，系统 SHALL 沿用既有 `SECRET_PATTERN` 脱敏规则。

## Non-Goals

- 不做服务器端分享链接 / 短链（无后端定位）。
- 不做 PDF 导出。
- 不做跨会话批量导出（备份功能已覆盖整库导出）。
- 不做长图的自定义主题/水印编辑（首期用当前主题气泡样式）。
