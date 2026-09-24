# 需求实施计划

- [x] 1. 设置存储
  - [x] 1.1 复用 `@easychat2_chat_options` 的 `fullWidth` 字段，默认 `false`（需求 1.2）

- [x] 2. 检查点 - 确保所有可运行验证通过

- [x] 3. 界面接入
  - [x] 3.1 `MessageBubble` 与 `ErrorBubble` 新增 `fullWidth` 属性，气泡与内容容器宽度在限宽与全宽样式间切换（需求 1.4、1.5、2.1、2.2）
  - [x] 3.2 新增 `bubbleBounded` / `bubbleFullWidth` / `messageContentFullWidth` 样式令牌（设计「组件与接口」）
  - [x] 3.3 设置页「全局配置」新增「全宽对话」开关（需求 1.1、1.3）
  - [x] 3.4 `ChatScreen` 在导航聚焦时读取设置并下传（需求 1.5）
  - [x] 3.5 全宽助手消息采用头像/名字头部与下方气泡的纵向布局，头像位于名字左侧
  - [x] 3.6 大型完整 HTML 使用本地文件源、内部滚动和渲染高度上限

- [x] 4. 回归与文档
  - [x] 4.1 脚本验证：`getChatOptions` 对 `fullWidth` 缺失与非法值的回退（设计「测试策略」）
  - [x] 4.2 打包验证 `npx expo export --platform android`
  - [x] 4.3 文档同步