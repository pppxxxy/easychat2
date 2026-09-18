# 需求实施计划

- [x] 1. Provider 声明表
  - [x] 1.1 `src/imageGen/providers.js`：内置 z-image、wan-image、qwen-image、FLUX.2-klein-4B、GLM-Image 与 OpenAI 兼容模板（需求 1.1、1.6）
  - [x] 1.2 声明覆盖 auth 三种方式、模型/prompt/negative/size/steps/guidance/seed 映射、t2i 与 i2i 模板、响应路径（需求 1.2、1.3、1.5）

- [x] 2. 统一适配层
  - [x] 2.1 `generateImage({ provider, prompt, imageFile?, imageUrl?, model?, size?, seed?, extra? })` 返回 `{ images, raw }`（需求 2.1、2.2）
  - [x] 2.2 请求构造：GET 查询参数、POST JSON、header/body/query 认证、multipart/base64/url 图生图（需求 1.4）
  - [x] 2.3 超时、重试与 401/429/其他非 2xx 友好提示（需求 2.3）
  - [x] 2.4 响应解析兼容 url、base64、`b64_json`、`data[].url`、`images[].url`（需求 1.5）

- [x] 3. 检查点 - 确保所有可运行验证通过

- [x] 4. 设置存储与面板
  - [x] 4.1 `storage.js` 新增 `getImageGenSettings` / `saveImageGenSettings`（键 `@easychat2_image_gen`）（需求 3.3）
  - [x] 4.2 设置面板填写 API 地址、API Key、模型名与额外参数 JSON（需求 3.2）

- [x] 5. 生成界面
  - [x] 5.1 provider 与模型下拉、prompt 输入、尺寸与种子、上传图片（带预览）（需求 4.1、4.5）
  - [x] 5.2 生成加载态与错误提示（需求 4.2、4.4）
  - [x] 5.3 结果画廊，点击支持保存/分享与复制（需求 4.3）
  - [x] 5.4 提供「填密钥」按钮打开设置面板（需求 3.1）

- [x] 6. 检查点 - 确保所有可运行验证通过

- [x] 7. 回归与文档
  - [x] 7.1 脚本验证请求构造、参数映射、响应解析、错误映射（设计「测试策略」）
  - [x] 7.2 打包验证 `npx expo export --platform android`（设计「测试策略」）
  - [x] 7.3 同步 `.monkeycode/docs/` 生图模块章节