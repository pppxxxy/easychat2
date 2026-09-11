# 架构设计

## 概述

EasyChat2 是一个基于 Expo 与 React Native 构建的移动端 AI 聊天应用，面向希望在手机上使用自有大模型 API Key 进行对话的个人用户。应用兼容 OpenAI 的 Chat Completions 协议，通过一个可配置的 API 地址、模型名和密钥与任意兼容服务（如 DeepSeek、OpenAI 或自建网关）通信。

应用采用单机、无后端的形态：所有配置、角色设定与聊天记录都保存在设备本机的 `AsyncStorage` 中，不经过任何自建服务器。应用由三个底部标签页组成——聊天、角色、设置，分别负责对话、角色管理与 API 配置，并通过一个全局 `AppContext` 共享当前角色状态。

在能力上，应用支持按角色隔离的多会话聊天、Markdown 格式的助手回复渲染、可折叠并一键复制的系统报错气泡，以及从 SillyTavern 风格的 PNG 或 JSON 角色卡导入人设。请求层内置 30 秒超时与错误格式化，报错展示前会对疑似密钥字符串做脱敏。

架构上强调几项特征：角色状态集中在 Context 并采用乐观写入加失败回滚；消息持久化以 `characterId` 为维度隔离，并保留对旧版单会话数据的兼容读取；运行时的 Buffer 兼容垫片与 Metro 的 `package exports` 开关共同保证 ESM 依赖 `parsecard` 能正确打包。

## 技术栈

**语言与运行时**
- JavaScript（ES2018+），JSX
- React 18.2.0
- React Native 0.73.6
- Expo SDK ~50.0.0
- Node.js 20（CI 构建环境）

**框架与库**
- 界面：`react-native` 原生组件、`react-native-safe-area-context`、`react-native-gesture-handler`
- 导航：`@react-navigation/native` + `@react-navigation/bottom-tabs`
- 富文本：`react-native-markdown-display`
- 图标资源：`react-native-vector-icons`

**数据存储**
- `@react-native-async-storage/async-storage`（设备本机键值存储）
- 无服务端数据库、无缓存层

**基础设施**
- 构建与分发：Expo、EAS Build、GitHub Actions
- 打包器：Metro（`expo/metro-config`）
- 转译：Babel（`babel-preset-expo`）

**外部服务**
- 任意兼容 OpenAI Chat Completions 的 HTTP 接口（默认预设 DeepSeek）
- SillyTavern 角色卡文件解析库 `parsecard`

## 项目结构

```
easychat2/
├── App.js                    # 应用入口：垫片、导航容器、全局 Provider
├── app.json                  # Expo 应用元数据与 Android 权限
├── eas.json                  # EAS Build 配置
├── metro.config.js           # Metro 打包配置（开启 package exports）
├── babel.config.js           # Babel 预设
├── package.json              # 依赖清单与 npm 脚本
├── .npmrc                    # npm 配置（legacy-peer-deps）
├── assets/                   # 图标、自适应图标与启动图
├── src/
│   ├── ChatScreen.js         # 聊天界面：消息列表、发送、错误气泡、持久化
│   ├── CharacterScreen.js    # 角色设置与角色卡导入
│   ├── SettingsScreen.js     # API 地址 / 模型 / Key 配置
│   ├── api.js                # 大模型接口调用与错误格式化
│   ├── storage.js            # AsyncStorage 读写封装与默认值
│   ├── polyfills.js          # Buffer 运行时兼容垫片
│   └── context/
│       └── AppContext.js     # 全局角色状态与更新逻辑
└── .github/workflows/        # APK 构建与 EAS 调试流水线
```

**入口点**
- `App.js` - 应用启动，注册导航与 `AppProvider`
- `package.json` 的 `main` 指向 `node_modules/expo/AppEntry.js`，由 Expo 加载 `App.js`
- `src/polyfills.js` - 必须在任何业务代码之前加载

## 子系统

### 应用外壳与导航
**目的**: 初始化运行时垫片、全局 Provider，并组织三个标签页
**位置**: `App.js`
**关键文件**: `App.js`
**依赖**: `src/polyfills.js`、`react-native-gesture-handler`、`@react-navigation/*`、`src/context/AppContext.js`
**被依赖**: 全体界面通过导航挂载

### 聊天界面
**目的**: 管理消息列表、发送请求、展示助手 Markdown 回复与系统报错气泡，并按角色持久化会话
**位置**: `src/ChatScreen.js`
**关键文件**: `src/ChatScreen.js`
**依赖**: `src/api.js`、`src/storage.js`、`src/context/AppContext.js`、`expo-clipboard`、`react-native-markdown-display`
**被依赖**: `App.js`

### 角色管理
**目的**: 编辑角色名与人设，并从 PNG/JSON 角色卡导入
**位置**: `src/CharacterScreen.js`
**关键文件**: `src/CharacterScreen.js`
**依赖**: `parsecard`、`expo-document-picker`、`expo-file-system`、`buffer`、`src/context/AppContext.js`
**被依赖**: `App.js`

### API 配置界面
**目的**: 维护 API 地址、模型与密钥，并对非 HTTPS 地址做发送前二次确认
**位置**: `src/SettingsScreen.js`
**关键文件**: `src/SettingsScreen.js`
**依赖**: `src/storage.js`
**被依赖**: `App.js`

### 全局角色状态
**目的**: 加载、共享并更新当前角色，提供失败回滚与加载完成标志
**位置**: `src/context/AppContext.js`
**关键文件**: `src/context/AppContext.js`
**依赖**: `src/storage.js`
**被依赖**: `ChatScreen`、`CharacterScreen`

### 数据持久化
**目的**: 以稳定键名读写 API 配置、角色与按角色隔离的消息，屏蔽 `AsyncStorage` 细节
**位置**: `src/storage.js`
**关键文件**: `src/storage.js`
**依赖**: `@react-native-async-storage/async-storage`
**被依赖**: `AppContext`、`ChatScreen`、`SettingsScreen`、`api.js`

### 网络请求
**目的**: 归一化接口地址、发起带超时的请求、格式化错误响应
**位置**: `src/api.js`
**关键文件**: `src/api.js`
**依赖**: `src/storage.js`、全局 `fetch`、`AbortController`
**被依赖**: `ChatScreen`

### 运行时兼容与打包
**目的**: 为 `parsecard` 提供 `Buffer` 全局与 ESM 入口解析
**位置**: `src/polyfills.js`、`metro.config.js`
**关键文件**: `src/polyfills.js`、`metro.config.js`
**依赖**: `buffer`、`expo/metro-config`
**被依赖**: 由 `App.js` 在启动时首先加载

## 图表

### 运行时组件依赖

```mermaid
flowchart TB
    subgraph UI["界面层 (src/)"]
        App["App.js 应用外壳与底部导航"]
        Chat["ChatScreen 聊天界面"]
        Character["CharacterScreen 角色管理"]
        Settings["SettingsScreen API 配置"]
    end
    subgraph STATE["状态层"]
        Context["AppContext 全局角色状态"]
    end
    subgraph DATA["数据层"]
        Storage["storage.js AsyncStorage 封装"]
    end
    subgraph NET["网络层"]
        Api["api.js 兼容 OpenAI 调用"]
    end
    Device["AsyncStorage 本机键值存储"]
    LLM["外部大模型 HTTP 接口"]

    App --> Chat
    App --> Character
    App --> Settings
    App --> Context
    Chat --> Context
    Character --> Context
    Settings --> Storage
    Context --> Storage
    Chat --> Storage
    Chat --> Api
    Api --> Storage
    Storage --> Device
    Api --> LLM
```

### 消息发送时序

```mermaid
sequenceDiagram
    participant U as 用户
    participant C as ChatScreen
    participant S as storage.js
    participant A as api.js
    participant L as 大模型接口

    U->>C: 点击发送
    C->>C: 追加 user 消息与 pending 助手占位
    C->>A: sendChatMessage(system + history + 新消息)
    A->>S: getApiConfig()
    S-->>A: baseUrl / model / apiKey
    A->>L: POST {baseUrl}/v1/chat/completions
    L-->>A: choices[0].message.content
    A-->>C: 回复文本
    C->>C: 用回复替换 pending 占位
    C->>S: saveMessages(characterId, messages)
```

### 助手消息状态

```mermaid
stateDiagram-v2
    [*] --> Pending: 发送后写入占位
    Pending --> Assistant: 收到回复
    Pending --> SystemError: 请求失败
    Assistant --> [*]
    SystemError --> [*]
```

## 设计决策

- **角色状态集中在 Context 并提供加载完成标志**：`AppContext` 通过 `characterRef` 与 `loadedRef` 保存最新值，避免闭包过期；未加载完成前拒绝写入，保证界面与存储一致。
- **乐观写入加失败回滚**：`updateCharacter` 先更新内存与界面状态，再落盘；落盘失败时回滚到旧值并向上抛出，由调用方决定如何提示用户，Context 不承担界面展示职责。
- **消息按角色隔离**：消息键为 `@easychat2_messages::<characterId>`；默认角色读取时兜底旧键 `@easychat2_messages`，实现旧版本数据平滑迁移。
- **pending 消息不落盘**：`storage` 与 `ChatScreen` 都会过滤 `pending` 标记的占位消息，避免把「正在思考…」写入历史。
- **报错原文只留内存**：持久化消息中只保存脱敏后的 `detail`，未脱敏原文保存在仅会话内可见的 `errorRawRef`，防止密钥写入磁盘。
- **切换角色的竞态防护**：发送期间记录发起时的 `characterId`，若用户中途切换角色，迟到返回的回复或错误会被丢弃。
- **请求超时与错误归一**：`api.js` 用 `AbortController` 实现 30 秒超时，并把非 JSON、HTML 响应统一成可读文案。
- **运行时垫片先行**：`Buffer` 垫片置于 `App.js` 首行导入，规避 ES 模块提升导致的求值顺序问题；Metro 全局开启 `unstable_enablePackageExports` 以解析 `parsecard` 的 `exports` 字段。
