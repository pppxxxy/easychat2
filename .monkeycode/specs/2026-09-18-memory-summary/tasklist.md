# 需求实施计划

- [x] 1. 会话总结边界与存储
  - [x] 1.1 `src/context/sessionLibrary.js` 的 `normalizeSession` 增加 `summarizedUpTo` 字段，`createEmptySession` 与 `buildClonedSession` 初始化为空（设计「数据模型」）
  - [x] 1.2 `src/storage.js` 新增按会话更新总结边界的方法并持久化，边界仅允许单调前移（设计「正确性属性」1）
  - [ ]* 1.3 属性测试：边界单调前移、克隆不携带源边界之外的状态（设计「正确性属性」1）

- [x] 2. memorySummary 逻辑与 LLM 调用
  - [x] 2.1 新建 `src/memorySummary.js`，实现 `selectSummarizable(messages, summarizedUpTo, keepRecent)`：返回边界之后、且保留最近若干条以外的连续消息（需求 2.2、5.2）
  - [x] 2.2 实现 `shouldSummarize(session, messages, settings)`：自动触发需开关开启且消息数达到阈值且有可总结消息（需求 2.1、2.3）
  - [x] 2.3 实现 `buildSummaryPrompt(messages)` 与 `parseSummaryResponse(text)`：解析 LLM 返回的摘要与关键词，兼容代码块与非法 JSON，关键词为空时兜底（需求 4.1、4.2；设计「错误处理」）
  - [x] 2.4 实现 `generateSummary({ character, messages })`：调用 `sendChatMessage` 生成摘要（需求 4.1）
  - [x] 2.5 实现 `applySummary({ session, character, messages, updateCharacter })`：把摘要写入角色世界书（名称带「记忆总结」与序号、关键词写入 keys、关键词触发、持续累积），并更新会话边界（需求 4.2、4.3、4.4、4.5；设计「正确性属性」3、4）
  - [x] 2.6 实现 `buildMemorySummaryText(character)`：拼接世界书中「记忆总结」条目的摘要，供请求压缩（需求 5.1）
  - [ ]* 2.7 单元脚本：阈值判断、边界选择、关键词兜底、非法 JSON（设计「测试策略」）

- [x] 3. 检查点 - 确保所有可运行验证通过
  - 确保所有验证通过,如有疑问请询问用户

- [x] 4. chatPipeline 摘要注入
  - [x] 4.1 `buildRequestMessages` 增加可选 `summaryText`，在预设之后插入 `[记忆摘要]` 系统段（需求 5.1；设计「组件与接口」）
  - [ ]* 4.2 请求压缩脚本：有/无摘要时的消息序列对比（设计「测试策略」）

- [x] 5. ChatScreen 集成
  - [x] 5.1 发送前按 `summarizedUpTo` 截断历史并传入摘要文本，实现请求压缩（需求 5.1、5.2、5.3）
  - [x] 5.2 顶部栏新增「总结记忆」按钮，手动触发忽略开关、进行中互斥、完成后提示（需求 3.1、3.2、3.3、6.2）
  - [x] 5.3 收到回复后按开关与阈值自动触发一次总结（需求 2.1）
  - [x] 5.4 总结失败时保留原状并提示，不更新边界（需求 6.1；设计「错误处理」）
  - [ ]* 5.5 生命周期脚本：自动触发次数、互斥、失败保留（设计「测试策略」）

- [x] 6. 检查点 - 确保所有可运行验证通过
  - 确保所有验证通过,如有疑问请询问用户

- [x] 7. 回归验证
  - [x] 7.1 运行 `npx expo export --platform android` 验证打包成功（设计「测试策略」）
  - [x] 7.2 同步 `.monkeycode/docs/` 中记忆总结、请求组装与世界书相关章节（需求 1—6）