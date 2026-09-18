# 需求文档：生图模块

## 简介

新增通用生图模块：声明式配置各生图服务，统一适配层调用；界面提供设置面板、文生图、图生图与结果画廊。

## 术语表

- **生图服务（Provider）**：一个生图 API 服务，如 z-image、FLUX.2-klein-4B。
- **文生图（t2i）**：仅由 prompt 生成图片。
- **图生图（i2i）**：在输入图片基础上生成。
- **结果画廊**：生成图片的展示区。

## 需求

### 需求 1：声明式配置与统一适配

**用户故事：** 作为用户，我希望只填 API 地址与密钥就能接入不同生图服务。

#### 验收标准

1. 系统应以声明式配置描述各生图服务，不为每个服务写死分支。
2. 每个服务配置应支持：名称、接口地址或完整 endpoint、请求方法、认证方式（header/body/query）与字段名、模型字段、prompt 字段、negative_prompt、尺寸（size 或 width/height）、steps、guidance、seed 等参数映射。
3. 配置应支持文生图与图生图两套请求模板。
4. 图生图模板应同时支持 `multipart/form-data` 上传文件与在字段中传 base64 或图片 URL。
5. 配置应支持响应解析路径，覆盖图片 URL、base64、`b64_json`、`data[].url`、`images[].url` 等。
6. 系统应内置 z-image、wan-image、qwen-image、FLUX.2-klein-4B、GLM-Image 的配置模板；无公开标准接口的按 OpenAI 兼容或可编辑 JSON 模板给出占位并允许手动修改。

### 需求 2：统一接口

#### 验收标准

1. 系统应提供统一调用 `generateImage({ provider, prompt, imageFile?, imageUrl?, model?, size?, seed?, extra? })`。
2. 返回结构应为 `{ images: [{ url?, base64? }], raw }`。
3. 系统应支持超时、错误码转换、429 与 401 的友好提示以及必要重试。

### 需求 3：设置面板

#### 验收标准

1. 界面应提供「填密钥」按钮，打开设置面板。
2. 面板应可填写各服务的 API 地址、API Key、模型名与额外参数。
3. 密钥应保存在本机（AsyncStorage），不硬编码、不写入文档。

### 需求 4：生成界面

#### 验收标准

1. 界面应提供 provider 与模型下拉、prompt 输入、上传图片控件（带预览）与生成按钮。
2. 生成过程应显示加载状态。
3. 完成后应展示结果画廊，并支持下载与复制。
4. 出错时应给出友好提示。
5. 图生图入口在校验到输入图片后才可生成。

## 参考

- `.monkeycode/docs/INDEX.md`