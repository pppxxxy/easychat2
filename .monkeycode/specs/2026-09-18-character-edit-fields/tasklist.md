# 需求实施计划

- [x] 1. 数据模型
  - [x] 1.1 `DEFAULT_CHARACTER` 与 `normalizeCharacter` 新增 `alternateGreetings`、`mesExample`、`nudgeText`（需求 4.1、4.2）
  - [x] 1.2 `cardParser` 读取 `alternate_greetings` 与 `extensions.nudge_text`（需求 4.3）
  - [x] 1.3 `cardExporter` 写出 `alternate_greetings` 与 `extensions.nudge_text`（需求 4.3）

- [x] 2. 检查点 - 确保所有可运行验证通过

- [x] 3. 角色编辑
  - [x] 3.1 备用开场白多条增删改（需求 1.1、1.4）
  - [x] 3.2 对话示例多行编辑（需求 2.1、2.4）
  - [x] 3.3 拍一拍文案编辑，占位提示默认模板（需求 3.2）

- [x] 4. 注入与互动
  - [x] 4.1 `chatPipeline` 在 `[用户设定]` 之后注入 `[对话示例]`，为空不注入（需求 2.2、2.3）
  - [x] 4.2 聊天页双击角色头像触发拍一拍，追加本地消息不发请求（需求 3.1）
  - [x] 4.3 拍一拍文案取值：角色自定义 > 全局默认 > 内置模板；支持 `{user}`/`{char}` 与 `{{user}}`/`{{char}}`（需求 3.3、3.4）
  - [x] 4.4 设置页新增「默认拍一拍文案」（需求 3.4）

- [x] 5. 检查点 - 确保所有可运行验证通过

- [x] 6. 回归与文档
  - [x] 6.1 脚本验证：对话示例注入、角色卡往返保留新字段、卡解析读取新字段（设计「测试策略」）
  - [x] 6.2 打包验证 `npx expo export --platform android`
  - [x] 6.3 文档同步