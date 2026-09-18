# 需求实施计划

- [x] 1. 解析思考内容
  - [x] 1.1 `api.js` 新增 `extractReasoningDelta`，兼容 `reasoning_content` 与 `reasoning`，覆盖 `delta` 与 `message` 两种形态（需求 1.1、1.3）
  - [x] 1.2 `sendChatMessage` 新增 `options.onReasoning`，流式逐段累计回调（需求 1.1、1.2）
  - [x] 1.3 非流式整包分支解析并回调一次思考内容（需求 1.2）

- [x] 2. 检查点 - 确保所有可运行验证通过

- [x] 3. 存储与设置
  - [x] 3.1 `thinking` 设置扩展 `display`（`open` / `fold` / `off`，默认 `fold`）（需求 2.1、2.2）
  - [x] 3.2 设置页「思考内容展示」三态选择，保存时先读回当前设置再合并，避免覆盖 `enabled` 与 `level`（需求 2.1、2.3、4.1、4.2）

- [x] 4. 界面展示
  - [x] 4.1 助手占位消息新增 `reasoning` 字段，`onReasoning` 实时更新（需求 3.5）
  - [x] 4.2 `MessageBubble` 按 `display` 渲染：完整展开、折叠一行可展开、不展示（需求 3.1、3.2、3.3）
  - [x] 4.3 思考为空时不渲染、`off` 时不进入渲染树（需求 3.4）
  - [x] 4.4 思考内容随消息持久化（`pending` 占位仍不落盘）（需求 1.4）

- [x] 5. 检查点 - 确保所有可运行验证通过

- [x] 6. 回归与文档
  - [x] 6.1 脚本验证：`display` 默认与非法回退；SSE 与非流式思考解析；无字段不回调（设计「测试策略」）
  - [x] 6.2 打包验证 `npx expo export --platform android`
  - [x] 6.3 文档同步