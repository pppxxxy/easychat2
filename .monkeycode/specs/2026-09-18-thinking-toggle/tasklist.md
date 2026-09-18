# 需求实施计划

- [x] 1. 思考设置与来源声明
  - [x] 1.1 `src/storage.js` 新增 `getThinkingSettings` / `saveThinkingSettings`，键 `@easychat2_thinking`，默认 `{ enabled: false, level: 'medium' }`（需求 1.3；设计「数据模型」）
  - [x] 1.2 `ApiConfig` 增加可选 `thinking` 声明（`field`、`format: effort | boolean | object`），缺省 `reasoning_effort`（需求 3.1；设计「组件与接口」）
  - [ ]* 1.3 单元脚本：设置默认与归一化（设计「测试策略」）

- [x] 2. 请求注入
  - [x] 2.1 `src/api.js` 新增 `buildThinkingParams(config, settings)`，按格式注入字段（需求 2.2、3.1）
  - [x] 2.2 未开启或来源不支持时不注入（需求 2.3、3.2；设计「正确性属性」1、3）
  - [ ]* 2.3 单元脚本：三种格式与未开启场景（设计「测试策略」）

- [x] 3. 检查点 - 确保所有可运行验证通过
  - 确保所有验证通过,如有疑问请询问用户

- [x] 4. 界面
  - [x] 4.1 `SettingsScreen` 能力确认弹窗增加思考参数字段名与格式选择（需求 3.1）
  - [x] 4.2 `ChatScreen` 顶部栏新增「思考」入口，提供开关与深度（低/中/高）（需求 1.1、2.1）
  - [x] 4.3 来源不支持思考时禁用并说明（需求 1.2；设计「正确性属性」3）
  - [x] 4.4 开关与深度持久化，重启保留（需求 1.3；设计「正确性属性」4）
  - [ ]* 4.5 界面脚本：禁用态、深度选择、持久化（设计「测试策略」）

- [x] 5. 回归验证
  - [x] 5.1 运行 `npx expo export --platform android` 验证打包成功（设计「测试策略」）
  - [x] 5.2 同步 `.monkeycode/docs/` 中 API 配置与聊天页相关章节（需求 1—3）