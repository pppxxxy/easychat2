# EasyChat2

**当前版本：1.0.0（正式版）**

EasyChat2 是一个基于 Expo + React Native 的移动端 AI 聊天应用。它没有自建后端，直接连接任意兼容 OpenAI Chat Completions 协议的接口，所有配置、角色与聊天记录都保存在设备本地。

## 下载安装

正式版 1.0.0 安装包（Android，约 60 MB）：

**[下载 EasyChat2-v1.0.0.apk](https://github.com/pppxxxy/easychat2/releases/download/v1.0.0/EasyChat2-v1.0.0.apk)**

历史版本与更新说明见 [Releases](https://github.com/pppxxxy/easychat2/releases)。安装时系统可能提示「未知来源」，允许安装该来源即可。

## 功能特性

- **兼容 OpenAI 协议**：支持 OpenAI、DeepSeek 及任意兼容 OpenAI Chat Completions 的接口，请求由应用发往你配置的地址。
- **多套 API 配置**：可保存、切换、编辑多组「接口地址 + 模型 + 密钥」，并支持一键拉取模型列表。
- **角色库**：新建、编辑、删除角色，随时在聊天页顶部切换当前角色。
- **角色卡导入**：支持从 PNG 或 JSON 角色卡导入人设、世界书与正则脚本。
- **世界书与正则**：世界书按关键词在发送前注入提示词；正则脚本可分别在发送与界面展示时生效。
- **Markdown 渲染**：助手回复按 Markdown 渲染，用户与报错消息保持纯文本。
- **用户人设与全局预设**：配置你的称呼与头像，并维护对所有对话生效的追加提示词。
- **会话隔离**：聊天记录按会话分别存储，切换角色或会话时中断进行中的请求并丢弃迟到回复。
- **图片与表情包**：图片附件会拆分为媒体消息，表情包可从相册添加、缩放并重复发送。
- **富 HTML 与大角色卡**：支持大型本地角色文件、独立 HTML 开场白、CSP 限制和全宽消息布局。
- **报错可复制**：请求失败以可折叠气泡展示，复制前会对疑似密钥做脱敏。

## 环境要求

- Node.js 20（CI 使用版本）
- 手机安装 Expo Go（调试），或使用构建好的 APK
- 一个可用的、兼容 OpenAI Chat Completions 的 API 地址与密钥

## 快速开始

```bash
npm install
npm run start
```

用 Expo Go 扫描终端里的二维码即可在真机上调试。依赖安装若遇到 peer 冲突，仓库的 `.npmrc` 已设置 `legacy-peer-deps=true`，保持默认即可。

常用脚本：

```bash
npm run start        # 启动 Expo 开发服务器
npm run android      # 直接在 Android 上打开
npm run prebuild     # expo prebuild --clean，重新生成 android/
npm run build:apk    # EAS 预览 APK 构建
```

> 本项目提供 `npm test` Node 回归测试；原生模块、WebView、权限和触摸交互仍需运行 `npm run start` 并手动走通受影响路径。

## 使用指南

应用由五个底部标签页组成：聊天 / 记忆 / 角色 / 扩展 / 设置。

### 1. 设置 API

进入「设置」页，在「API 配置」卡片中填写：

| 字段 | 说明 |
|------|------|
| **API 地址** | 兼容 OpenAI 格式的端点，例如 `https://api.deepseek.com` |
| **模型** | 模型名称，例如 `deepseek-chat`、`gpt-4o` |
| **API Key** | 对应的密钥（明文存于本机） |

可保存多套配置并随时切换；填写完成后可拉取可用模型列表并直接选用。

> 如果 API 地址使用 `http://` 协议，保存时会弹出二次确认——未加密传输下 API Key 存在明文泄露风险。

同一页还可配置「用户人设」（你的称呼与头像）和「对话预设」（对全部角色生效的追加提示词）。

### 2. 角色

在「角色」页管理角色库：

- 新建角色并编辑角色名、开场白、系统提示词、描述、性格、场景等字段。
- 导入角色卡：支持 PNG（内嵌 `chara` 数据）与 JSON 两种格式，会一并解析世界书与正则脚本。
- 切换当前角色：在聊天页顶部的角色胶囊中点选即可。

### 3. 聊天

返回聊天页即可开始对话：

- 助手回复支持 Markdown 渲染；代码块使用等宽字体。
- 每条消息下方提供「复制」「选择文本」，用户文字消息可「修改重发」（会先确认撤回范围），助手消息可「重新生成」。
- 输入栏可添加图片或文本附件，图片与文字会按媒体消息、文字消息顺序发送；右侧笑脸按钮打开表情包面板。
- 「设置 → 全局配置 → 全宽对话」开启后，角色头像与名字置于消息上方，头像位于名字左侧，消息框横向铺满聊天区域。
- 顶部「公告」按钮随时查看免责条款；输入栏「清空」可删除当前会话记录。

## 安全与隐私

- 无自建后端，不收集数据；配置、角色与聊天记录仅存于本机 `AsyncStorage`。
- 聊天内容与 API Key 会直接发送到你填写的第三方 API 地址，请自行确认其可信度。
- 导入内容与聊天内容的合法性由你负责；软件按现状提供，无任何担保。
- 应用不主动申请运行时权限，并已排除存储相关权限，详见安全声明。

完整说明见 [SECURITY.md](./SECURITY.md)，涵盖本地存储键、Android 权限、依赖行为与 `http://` 明文传输风险。

## APK 构建

仓库提供两条构建路径，都需要在 GitHub Actions 里手动触发（`workflow_dispatch`）：

1. **Build APK on GitHub**（`build-apk-github.yml`）：在 GitHub runner 上 `prebuild` + Gradle 打 release APK，不依赖 EAS。构建完成后从 Actions 的 Artifacts 下载。
2. **Build APK**（`build-apk.yml`）：调用 Expo EAS 云构建。需要在仓库 Secrets 中配置 `EXPO_TOKEN`。

### 用 GitHub Desktop 触发（推荐 Build APK on GitHub）

GitHub Desktop 只能帮你打开仓库网页，触发构建在浏览器完成：

1. 在 GitHub Desktop 点击菜单 **Repository → View on GitHub**（快捷键 `Ctrl+Alt+G` / `Cmd+Alt+G`）打开仓库网页。
2. 直接打开构建工作流页：`https://github.com/pppxxxy/easychat2/actions/workflows/build-apk-github.yml`
3. 点击右侧 **Run workflow** 下拉框，确认分支为 `main`，再点绿色 **Run workflow** 按钮。
4. 刷新页面，等待该次运行变绿（约 10–15 分钟）。
5. 进入该次运行，在页面底部 **Artifacts** 下载 `easychat2-apk`（zip 压缩包），解压得到 `app-release.apk`，传到手机安装。

> Build APK on GitHub 无需任何 Token；首次运行若提示授予工作流权限，允许即可。

本地也可以打预览包（需先全局安装 EAS CLI）：

```bash
npm install -g eas-cli
npm run build:apk
```

## 技术栈

- React 18.2.0 / React Native 0.73.6 / Expo SDK ~50
- 导航：`@react-navigation/native` + `@react-navigation/bottom-tabs`
- 富文本：`react-native-markdown-display`、`react-native-render-html`
- 图标：`@expo/vector-icons`（Ionicons）
- 存储：`@react-native-async-storage/async-storage`
- 角色卡解析：`parsecard`
- 打包：Metro（开启 `unstable_enablePackageExports`，以解析 `parsecard` 的 ESM 导出）

## 项目结构

```
easychat2/
├── App.js                    # 应用入口：垫片、导航容器、全局 Provider
├── app.json                  # Expo 应用元数据与 Android 权限
├── eas.json                  # EAS Build 配置
├── metro.config.js           # Metro 打包配置（开启 package exports）
├── assets/                   # 图标、自适应图标与启动图
├── src/
│   ├── ChatScreen.js         # 聊天界面：角色切换、消息列表、发送、错误气泡、持久化
│   ├── CharacterScreen.js    # 角色库陈列、角色编辑与角色卡导入
│   ├── SettingsScreen.js     # API 配置 / 用户人设 / 对话预设
│   ├── api.js                # 大模型接口调用（XHR 流式）与错误格式化
│   ├── cardParser.js         # 角色卡 JSON/PNG 解析与字段标准化
│   ├── lorebook.js           # 世界书条目激活判定
│   ├── regexEngine.js        # 正则脚本作用范围与应用
│   ├── chatPipeline.js       # 系统提示词 + 历史 + 用户消息组装
│   ├── storage.js            # AsyncStorage 读写封装与默认值
│   ├── disclaimer.js         # 免责条款文本与弹窗组件
│   ├── polyfills.js          # Buffer 运行时兼容垫片（必须最先加载）
│   └── context/AppContext.js # 全局角色库状态与更新逻辑
└── .github/workflows/        # APK 构建流水线
```

## 文档

- 架构与模块说明：`.monkeycode/docs/INDEX.md`
- 安全与隐私声明：[SECURITY.md](./SECURITY.md)
- 开发约定：[AGENTS.md](./AGENTS.md)

## 免责声明

本项目仅提供技术学习与交流，不构成任何形式的法律意见或对第三方服务的推荐。使用者应自行承担一切风险。

本软件面向成年人，**禁止未成年人下载、安装或使用**。请遵守所选 API 服务商的使用政策，并自行承担调用产生的费用与账号风险。

关于角色卡等第三方内容：本教程仅提供技术信息，不对任何第三方平台的内容合法性及安全性做出保证。使用者应自行确认内容的版权状态，避免使用未经授权改编的作品，并自行承担使用第三方平台的全部风险。

## 许可证

本项目以 **AGPL-3.0-or-later** 授权，按「现状（AS IS）」提供，不附带任何明示或默示的担保。完整条款见 [LICENSE](./LICENSE)。
