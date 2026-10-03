# EasyChat2 文档

本目录是 EasyChat2 的项目文档，面向希望了解系统结构、集成接口或参与开发的读者。文档基于当前代码仓库生成，描述实际实现。

**快速链接**: [架构](./ARCHITECTURE.md) | [接口](./INTERFACES.md) | [开发者指南](./DEVELOPER_GUIDE.md) | [进度交接](./进度交接.md) | [工具循环契约](./agent-loop.md)

---

## 恢复进度

若你（或上下文已被压缩的 Agent）需要知道「当前做到哪、下一步是什么」，先读 [进度交接](./进度交接.md)：分支结构、升级路线与版本链、待办、门禁基线与易踩的坑。架构与约定的权威来源仍是本目录的架构/接口文档与仓库根 `AGENTS.md`。

---

## 核心文档

### [架构](./ARCHITECTURE.md)
系统设计、技术栈、子系统划分、运行时依赖与关键流程。从这里开始了解应用如何运作。

### [接口](./INTERFACES.md)
界面组件、全局状态、持久化函数与外部 HTTP 契约。集成或改动模块时的参考。

### [开发者指南](./DEVELOPER_GUIDE.md)
环境搭建、运行与构建、编码规范与常见任务。贡献者必读。

### [工具循环契约](./agent-loop.md)
Agent 工具调用循环 v1 接口契约（数据结构、SSE 累积、循环算法、取消语义、模式门控、本地模型策略）。

---

## 模块

| 模块 | 描述 | 文档 |
|------|------|------|
| 界面层 | 应用外壳、导航与五个功能页面 | [文档](./模块/界面层.md) |
| 设计令牌 | 间距、圆角、描边、图标尺寸与阴影的统一来源 | [文档](./模块/设计令牌.md) |
| UI 组件 | 公共基础组件（Card / Button / Chip / Field / ListRow / SheetHeader） | [文档](./模块/UI组件.md) |
| 数据与状态 | AsyncStorage 域模块与全局角色库状态 | [文档](./模块/数据与状态.md) |
| 网络层 | 兼容 OpenAI 的接口调用、在线/本地选择与厂商统一请求 | [文档](./模块/网络层.md) |
| 卡解析与提示管线 | 角色卡解析、世界书与正则组装请求 | [文档](./模块/卡解析与提示管线.md) |
| 构建与配置 | 打包、原生插件、运行时垫片与 CI 流水线 | [文档](./模块/构建与配置.md) |

### 功能规格

- [聊天图片与表情包](../specs/2026-09-24-chat-stickers/requirements.md)：图片消息拆分、表情包面板、修改重发确认与媒体存储。
- [全宽对话](../specs/2026-09-18-full-width-chat/requirements.md)：全宽消息布局与头像/名字位置。

---

## 核心概念

理解这些领域概念有助于导航代码库：

| 概念 | 描述 |
|------|------|
| [角色库](./专有概念/角色库.md) | 全部角色的集合与当前角色选择 |
| [角色](./专有概念/角色.md) | 对话人格设定，同时是消息隔离维度 |
| [消息会话](./专有概念/消息会话.md) | 按会话隔离的对话历史与持久化 |
| [API 配置](./专有概念/API配置.md) | 接口地址、模型与密钥 |
| [角色卡](./专有概念/角色卡.md) | PNG / JSON 角色卡导入 |
| [世界书](./专有概念/世界书.md) | 按键触发的背景设定，发送前注入提示词 |
| [正则脚本](./专有概念/正则脚本.md) | 对消息文本做查找替换的规则 |
| [系统报错消息](./专有概念/系统报错消息.md) | 可折叠、可复制的请求失败提示 |

---

## 入门指南

### 项目新人？

按此路径学习：
1. [架构](./ARCHITECTURE.md) - 了解全局与运行时依赖
2. [核心概念](#核心概念) - 学习角色与消息的模型
3. [开发者指南](./DEVELOPER_GUIDE.md) - 搭建环境并运行
4. [接口](./INTERFACES.md) - 探索模块接口

### 需要自定义模型或接口？

1. [API 配置](./专有概念/API配置.md) - 地址归一化与字段约定
2. [网络层](./模块/网络层.md) - 请求与错误处理细节

### 首次贡献？

1. [开发者指南](./DEVELOPER_GUIDE.md) - 环境与工作流
2. [常见任务](./DEVELOPER_GUIDE.md#常见任务) - 分步操作指引
3. [编码规范](./DEVELOPER_GUIDE.md#编码规范) - 命名与样式约定

---

## 快速参考

### 命令

```bash
npm install          # 安装依赖
npm run start        # 启动 Expo 开发服务器
npm run android      # 在 Android 打开
npm run build:apk    # EAS 预览 APK
npm run prebuild     # 生成原生工程
npm test             # 运行 Node 单元与回归测试
```

### 重要文件

| 文件 | 目的 |
|------|------|
| `App.js` | 应用入口与导航（含主动消息消费与本地 API 服务桥） |
| `src/ChatScreen.js` | 聊天页接线与渲染（约 2358 行） |
| `src/chat/useChatSend.js` | 发送/接收/流式/重生成/群聊调度 |
| `src/chat/useSessionMessages.js` | 消息加载、落盘队列、草稿、附件引用 |
| `src/chat/useSessionSwitch.js` | 切换角色/会话/群聊、新建、开场白确认 |
| `src/chat/useSessionGuard.js` | 会话竞态守卫（版本号、单飞锁、AbortController） |
| `src/chat/MessageList.js` | 消息列表渲染（窗口化 + 加载更早） |
| `src/chat/replyFlow.js` | 回复流纯函数（合并/错误分类/重生成计划） |
| `src/chat/*` | 聊天页拆分模块：hook、纯函数、样式、消息气泡与各类弹窗 |
| `src/CharacterScreen.js` | 角色编辑与角色卡导入 |
| `src/ExtensionScreen.js` | 扩展页：游戏、生图、制卡与世界分组 |
| `src/theme/ThemeContext.js` | 主题与字体缩放的全局上下文 |
| `src/tts/index.js` | 语音播报适配层与播放控制 |
| `src/transcription.js` | 语音转写（多厂商 + 复用聊天来源） |
| `src/voiceMessages.js` | 语音消息结构与播放 |
| `src/moments/moments.js` | 动态触发判定与文本模板 |
| `src/imageGen/index.js` | 生图统一适配与响应解析 |
| `src/imageGen/localDream.js` | Local Dream 端侧生图（SSE + 原始 RGB） |
| `src/localModel/` | 本地大模型（模型管理、适配器、本地 API 服务、think 流切分） |
| `src/modelProvider.js` | 在线/本地推理选择与回退 |
| `src/storage/` | 存储域实现（io / backupStream / 各数据域） |
| `src/storage/backupStream.js` | 备份导出分块生成器（逐块可取消） |
| `src/cardParser.js` | 角色卡 JSON/PNG 解析与标准化 |
| `src/chatPipeline.js` | 世界书/正则/角色预设提示词组装 |
| `src/characterPresets.js` | 角色卡预设规范化与解析 |
| `src/storage.js` | 持久化门面（转发 `src/storage/`） |
| `src/secretStore.js` | 密钥安全存储（AsyncStorage 只留引用） |
| `src/api.js` | 大模型接口调用（`streamChatCompletion` 结构化 + `sendChatMessage` 薄包装） |
| `src/agent/loop.js` | Agent 工具调用循环（跨轮累积、上限收尾、取消） |
| `src/agent/tools/registry.js` | 工具注册表与 ask/read/write 模式门控 |
| `src/workspace/paths.js` | 工作区路径安全（沙盒相对路径 + 扩展名白名单） |
| `src/workspace/store.js` | 工作区文件 list/read/write（fileSystem 注入，可 Node 直测） |
| `src/workspace/tools.js` | 工作区三工具定义与注册（list/read/write） |
| `src/workspace/native.js` | 工作区原生默认入口（惰性加载 expo-file-system） |
| `src/vendorHttp.js` | 厂商请求统一层（XHR + SSE） |
| `src/context/AppContext.js` | 全局角色库状态 |
| `src/context/characterLibrary.js` | 角色库状态迁移纯函数 |
| `src/chatRace.js` | 切换角色的迟到回复守卫 |
| `plugins/withLocalApiServer.js` | 本地 OpenAI 兼容服务原生插件 |
| `plugins/withProactiveMessage.js` | 主动消息原生插件 |
| `app.json` | Expo 应用配置（`newArchEnabled: true`、插件链） |
| `metro.config.js` | 打包配置（package exports 开关） |
| `SMOKE_TEST.md` | 真机走查清单 |
