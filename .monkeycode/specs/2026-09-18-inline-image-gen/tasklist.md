# 需求实施计划

- [x] 1. NovelAI 适配
  - [x] 1.1 `imageGen/providers.js` 新增 `novelai`（Bearer 令牌、模型与采样参数映射、`sizeSplit` 声明）（需求 4.1—4.4）
  - [x] 1.2 `imageGen/index.js` 支持 `sizeSplit` 把 `宽*高` 拆为 width/height，非法值不覆盖模板默认（需求 4.4）
  - [x] 1.3 `imageGen/index.js` 支持 `response.mode === 'binary'`：非 JSON 响应包装为 base64 图片项（需求 4.3）
  - [x] 1.4 NovelAI 与既有 Provider 走同一调用路径，无专属分支（需求 4.5）

- [x] 2. 检查点 - 确保所有可运行验证通过

- [x] 3. 设置与存储
  - [x] 3.1 `storage.js` 新增 `getInlineImageSettings` / `saveInlineImageSettings`（键 `@easychat2_inline_image`）（设计「数据模型」）
  - [x] 3.2 设置页新增「对话配图」卡片：自动配图开关、生图服务、风格前缀、尺寸、提示词长度上限（需求 1.3、5.3、5.4）

- [x] 4. 聊天页配图
  - [x] 4.1 助手消息新增可选 `inlineImage` 字段，取值 `null` / `loading` / `done` / `error`（需求 2.1）
  - [x] 4.2 气泡下方渲染配图、加载态与失败重试（需求 2.3、2.4）
  - [x] 4.3 助手消息提供「生成配图」手动入口（需求 1.1、1.2）
  - [x] 4.4 自动配图开关开启时，助手回复完成后自动生成（需求 1.4、1.5）
  - [x] 4.5 未配置服务时提示前往设置且不发起请求（需求 3.1）
  - [x] 4.6 同一时刻并发限制为 1，重复触发提示稍后重试（需求 3.3）
  - [x] 4.7 `loading` 与 `error` 不持久化，`done` 随消息保存（需求 2.1、2.5）
  - [x] 4.8 提示词按长度上限截断并拼接风格前缀（需求 5.1、5.2）

- [x] 5. 检查点 - 确保所有可运行验证通过

- [x] 6. 回归与文档
  - [x] 6.1 脚本验证：NovelAI 请求构造与尺寸拆分、binary/base64 解析、既有解析不回退、设置默认与回退（设计「测试策略」）
  - [x] 6.2 打包验证 `npx expo export --platform android`
  - [x] 6.3 文档同步