# Requirements Document

## Introduction

EasyChat2 当前同一时刻只保留一个角色，导入新角色卡会覆盖旧角色。本功能引入「角色库」，把角色从单值升级为可陈列、可切换的集合，并确保每个角色对应独立的聊天记录与当前角色选择。功能覆盖角色的浏览、切换、新建、导入、编辑、删除，以及旧版单角色数据的迁移。

## Glossary

- **System**：EasyChat2 移动端应用。
- **角色库（Character Library）**：应用持久化的角色集合，包含一个或多个角色。
- **角色（Character）**：一套人格设定，含名称、系统提示词、世界书与正则脚本等字段，具备唯一 `id`。
- **当前角色（Active Character）**：用户当前正在对话的角色，同一时刻仅一个。
- **默认角色（Default Character）**：`id` 为 `default` 的内置角色。
- **角色卡（Character Card）**：可导入的 PNG 或 JSON 角色设定文件。
- **消息会话（Message Session）**：某角色名下按时间排列的消息列表。
- **角色条目（Character Entry）**：角色页列表中代表一个角色的可点击单元。
- **最近使用时间（Last Used Time）**：角色最近一次成为当前角色的时间戳。

## Requirements

### Requirement 1

**User Story:** AS 应用用户, I want 在一个列表中查看全部已保存角色并切换当前角色, so that 我可以在不同人设之间快速开始对话。

#### Acceptance Criteria

1. The system SHALL 在角色页展示角色库中全部角色构成的可滚动列表。
2. WHEN 用户点选一个角色条目, the system SHALL 将该角色设为当前角色。
3. WHILE 一个角色为当前角色, the system SHALL 在该角色条目上显示选中标记。
4. WHEN 当前角色发生变化, the system SHALL 将聊天页展示的消息切换为所选角色的消息会话。
5. The system SHALL 在聊天页顶部展示当前角色的名称，并通过点击该名称进入角色切换。
6. The system SHALL 将角色列表按最近使用时间降序排列。
7. WHEN 用户将某角色设为当前角色, the system SHALL 将该角色的最近使用时间更新为当前时间。

### Requirement 2

**User Story:** AS 应用用户, I want 每个角色的聊天记录彼此独立保存, so that 切换角色不会丢失或混淆对话。

#### Acceptance Criteria

1. The system SHALL 以角色 `id` 为键持久化每个角色的消息会话。
2. WHEN 用户在当前角色下发送消息, the system SHALL 仅将该消息写入当前角色的消息会话。
3. IF 目标角色不存在对应的消息会话, the system SHALL 以空消息列表初始化该角色的会话。
4. WHILE 用户切换当前角色, the system SHALL 保留先前角色已持久化的消息会话。

### Requirement 3

**User Story:** AS 应用用户, I want 在当前角色基础上新建空白角色或导入角色卡, so that 我可以扩充角色库。

#### Acceptance Criteria

1. WHEN 用户触发新建角色, the system SHALL 创建一个具备唯一 `id` 的空白角色并加入角色库。
2. WHEN 用户导入一张角色卡, the system SHALL 依据卡片内容创建一个具备唯一 `id` 的角色并加入角色库。
3. WHEN 一个新角色加入角色库, the system SHALL 将该新角色设为当前角色。
4. The system SHALL 为角色库中每个角色分配与其他角色不同的 `id`。

### Requirement 4

**User Story:** AS 应用用户, I want 编辑当前角色并保存, so that 修改对后续对话生效。

#### Acceptance Criteria

1. WHEN 用户保存角色编辑, the system SHALL 将改动写入角色库中对应的角色。
2. WHILE 用户编辑当前角色, the system SHALL 在保存后使改动作用于后续发送的请求。
3. WHEN 用户保存角色编辑, the system SHALL 仅修改被编辑角色的数据。

### Requirement 5

**User Story:** AS 应用用户, I want 从角色库删除不再需要的角色, so that 列表保持整洁。

#### Acceptance Criteria

1. WHEN 用户请求删除一个非默认角色, the system SHALL 在删除前展示确认提示。
2. WHEN 用户确认删除, the system SHALL 从角色库移除该角色。
3. WHEN 被删除角色拥有消息会话, the system SHALL 同时移除该角色的消息会话。
4. IF 被删除角色是当前角色, the system SHALL 将当前角色切换为角色库中的另一个角色。
5. IF 用户请求删除默认角色, the system SHALL 保留默认角色并提示该角色不可删除。

### Requirement 6

**User Story:** AS 应用用户, I want 应用升级后原有角色与聊天记录保持不变, so that 我不必重新配置。

#### Acceptance Criteria

1. WHEN 应用首次读取到旧版单角色数据, the system SHALL 将该角色写入角色库并设为当前角色。
2. WHILE 角色库存在, the system SHALL 对默认角色保留旧版消息键 `@easychat2_messages` 的兜底读取。
3. WHEN 迁移完成, the system SHALL 保留旧版角色键中的原始数据。

### Requirement 7

**User Story:** AS 应用用户, I want 应用重启后回到我最近使用的角色, so that 我可以继续上次的对话。

#### Acceptance Criteria

1. WHEN 用户切换当前角色, the system SHALL 持久化当前角色的 `id`。
2. WHEN 应用启动, the system SHALL 将当前角色恢复为最近一次持久化的当前角色。
3. IF 持久化的当前角色 `id` 不在角色库中, the system SHALL 将当前角色设为默认角色。

### Requirement 8

**User Story:** AS 开发者, I want 角色库的读写具备容错与稳定序列化, so that 损坏数据不会导致应用不可用。

#### Acceptance Criteria

1. The system SHALL 以 JSON 数组序列化角色库。
2. WHEN 读取角色库数据发生解析错误, the system SHALL 回退为仅含默认角色的角色库。
3. WHEN 读取到某个角色缺少必需字段, the system SHALL 以默认值补全该角色。
4. WHEN 角色库中不存在默认角色, the system SHALL 将默认角色加入角色库。