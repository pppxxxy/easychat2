# 角色编辑扩展 技术设计

Feature Name: character-edit-fields
Updated: 2026-09-18

## 描述

扩展角色对象与编辑表单，新增 `alternateGreetings`、`exampleDialogue`、`nudgeText`；对话示例注入系统提示词；拍一拍双击头像触发并在消息流中追加提示。

## 架构

```mermaid
graph TD
  A["CharacterScreen 编辑表单"] --> B["角色对象新字段"]
  B --> C["chatPipeline 注入对话示例"]
  B --> D["buildGreetingMessage 选择开场白"]
  B --> E["双击头像 -> 拍一拍消息"]
```

## 组件与接口

### 数据模型

```text
character.alternateGreetings?: string[]     // 备用开场白
character.exampleDialogue?: string          // 对话示例（多行）
character.nudgeText?: string                // 该角色的拍一拍文案
```

### `src/CharacterScreen.js`

- 新增表单区块：
  - 「备用开场白」：列表式多条编辑，支持增删。
  - 「对话示例」：多行输入。
  - 「拍一拍文案」：单行输入，占位显示默认文案。
- 保存时写入角色对象，空值存空字符串或空数组。

### `src/chatPipeline.js`

- `buildRequestMessages` 在系统提示词追加段落规则中，新增「对话示例」段：

```text
[对话示例]
<exampleDialogue>
```

- 仅在 `exampleDialogue` 非空时追加，位置排在 `[用户设定]` 之后、`[记忆摘要]` 之前。

### `src/ChatScreen.js`

- 双击头像：`MessageBubble` 的角色头像用 `Pressable` + 双击检测（记录上次点击时间，`< 300ms` 视为双击）。
- 拍一拍消息：以 `role: ASSISTANT_ID` 的普通消息追加，`text` 取角色 `nudgeText` 或默认模板。

```text
默认："{userName} 戳了戳 {characterName}"
自定义角色：角色 nudgeText 中的 {user} / {char} 占位替换
```

- 拍一拍消息参与持久化，不触发模型请求。

### `src/SettingsScreen.js`

- 新增「默认拍一拍文案」输入，存于用户人设设置；角色未自定义时使用。

### 角色卡

- `cardExporter` / `cardParser` 的字段映射同步新增字段（导出写入，导入读取并回退空值）。

## 正确性属性

1. 旧角色缺字段时读取与请求组装正常。
2. 对话示例为空不注入。
3. 拍一拍为本地消息，不发起请求。
4. 双击判定不误触单击（单击仍为切换角色等既有行为）。
5. 角色卡往返导出导入保留新字段。

## 错误处理

- 双击期间正在进行请求：拍一拍仍追加（本地行为），不影响请求。
- 文案占位缺失：回退默认模板。

## 测试策略

- 脚本：`buildRequestMessages` 含/不含 `exampleDialogue` 的输出对比。
- 脚本：拍一拍文案模板渲染（自定义与默认）。
- 脚本：角色卡往返字段保留。
- 打包验证与手动验证双击。

## 参考

[^1]: (src/CharacterScreen.js) - 编辑表单
[^2]: (src/chatPipeline.js) - 提示词组装
[^3]: (src/cardExporter.js)、`src/cardParser.js` - 角色卡字段
