# 需求实施计划

- [x] 1. 存储与请求
  - [x] 1.1 `storage.js` 新增 `getChatOptions` / `saveChatOptions`（键 `@easychat2_chat_options`）（需求 1.3）
  - [x] 1.2 `api.js` 的 `sendChatMessage` 新增 `options.stream`（默认 `true`），请求体写入该值（需求 2.1、2.2）
  - [x] 1.3 关闭流式时跳过增量解析，走既有整包 JSON 分支；保留取消、超时与错误提示（需求 2.3、2.4）

- [x] 2. 检查点 - 确保所有可运行验证通过

- [x] 3. 界面接入
  - [x] 3.1 设置页「全局配置」新增「流式输出」开关（需求 1.1、1.2）
  - [x] 3.2 `ChatScreen` 在导航聚焦时读取设置，并在单聊与群聊请求中传入（需求 1.4、1.5、3.1、3.4）

- [x] 4. 回归与文档
  - [x] 4.1 脚本验证：`getChatOptions` 默认值与非法回退；`sendChatMessage` 两种 stream 取值下的请求体与整包解析（设计「测试策略」）
  - [x] 4.2 打包验证 `npx expo export --platform android`
  - [x] 4.3 文档同步