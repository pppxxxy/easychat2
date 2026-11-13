# Windows 桌面版（首版：核心聊天闭环）需求文档

Feature Name: windows-desktop
Updated: 2026-11-11
状态：待用户确认（本轮只产出需求与技术设计，不写实现代码）

## Introduction

EasyChat2 目前是单机 Android 应用（Expo SDK 54 / React Native 0.81 / React 19.1，约 16.3 万行 JS + 7880 行 Kotlin 原生模块）。本需求定义它的 Windows 桌面版本：技术路线为 **Electron 外壳 + 全新 React DOM 界面**，共享层复用现有 `src/` 中的业务逻辑、协议层、存储层与国际化词条，界面按桌面交互重写。首版只交付**核心聊天闭环**，其余功能按后续版本逐批对齐。

本轮交付物为本文档与 `design.md`，代码实现不在本轮范围。

## Glossary

- **共享层（shared layer）**：`src/` 下不依赖 React Native 渲染、可在纯 Node 环境加载的模块集合（存储、提示词、协议、Agent、纯函数等）。
- **平台适配层（platform shims）**：桌面端为共享层的既有依赖（AsyncStorage、expo-file-system、expo-secure-store、`Alert`、`XMLHttpRequest`）提供的同契约替代实现。
- **主进程（main process）**：Electron 的 Node 进程，持有全部系统能力（文件、密钥、对话框、HTTP、协议注册）。
- **渲染进程（renderer）**：Chromium 中的 React DOM 应用，只通过 preload 暴露的白名单 API 访问系统能力。
- **文档目录（documentDirectory）**：应用私有数据根目录，桌面端形态为 `file:///C:/Users/<user>/AppData/Roaming/EasyChat2/`（带结尾斜杠）。
- **核心聊天闭环**：角色库 → 会话 → 消息收发（含流式与失败） → 渲染 → 本地持久化 → 导入导出 的完整可闭环路径。
- **备份包（backup payload）**：`schemaVersion: 1` 的 JSON 结构，见 `src/storage/dataBackup.js:11`，是 Android 与 Windows 之间唯一的数据迁移载体。
- **不变量（invariant）**：必须始终成立、可用测试断言的性质。

## Scope

### 首版包含

1. 角色库：新建、编辑、删除、置顶、切换当前角色。
2. 会话：新建、切换、置顶、克隆、删除、按角色分组。
3. 消息：发送文本、流式接收、思考内容展示、失败气泡、重新生成、编辑重发、撤回（分支归档）。
4. 渲染：Markdown、富 HTML、图片/表情包/视频占位、代码块。
5. 配置：API 配置（多套）、模型切换、采样参数、用户人设、外观与语言。
6. 附件：本地图片、表情包（导入/发送）、文档附件（按现有能力降级）。
7. 导入导出：角色卡（PNG/JSON）导入导出、全量备份导出与恢复。
8. 桌面交互：宽屏双栏布局、键盘快捷键、右键菜单、窗口尺寸记忆。
9. 打包：Windows x64 安装包（NSIS），CI 构建产物可下载。

### 首版不含（后续批次）

本地模型推理（`llama.rn`）、工作区 Agent 工具与 shell/python 执行、GitHub 集成、看屏幕悬浮窗、主动消息与定时任务、MCP 服务器、向量记忆、语音（TTS/ASR/录音）、生图、朋友圈/日记/世界地图/书架/音乐/小游戏、插件运行时、应用锁生物识别。

上述功能在首版界面中以「桌面版暂不支持」的禁用态呈现，点击给出说明，不隐藏入口（避免用户以为功能丢失）。

## Requirements

### Requirement 1：桌面应用外壳与进程边界

**User Story:** 作为 Windows 用户，我希望安装一个原生桌面应用，界面响应快，数据保存在本机。

#### Acceptance Criteria

1. The system SHALL 以 Electron 应用形态运行，主进程持有 Node 系统能力，渲染进程启用 `contextIsolation` 与 `sandbox` 并关闭 `nodeIntegration`。
2. WHEN 渲染进程需要文件、密钥、对话框或网络能力，THE system SHALL 仅通过 preload 经 `contextBridge` 暴露的白名单通道访问，通道清单在 `design.md` 中逐条固定。
3. IF 渲染进程请求的路径解析后位于允许根目录之外，THEN the system SHALL 拒绝该请求并返回结构化错误，不泄露绝对路径细节。
4. The system SHALL 在应用启动时创建并使用固定的文档目录与缓存目录，文档目录在应用升级后保持不变。
5. WHEN 窗口被关闭，THE system SHALL 按现有会话落盘队列完成收尾后再退出，未完成的流式回复不得以 `pending` 占位符形式写入磁盘。

### Requirement 2：复用共享业务逻辑（单一事实源）

**User Story:** 作为维护者，我希望桌面版与 Android 版共用同一套业务逻辑，避免同一 bug 修两遍。

#### Acceptance Criteria

1. The system SHALL 从 `src/` 直接导入共享层模块，同一逻辑在桌面端与 Android 端只保留一份实现。
2. The system SHALL 通过构建期模块别名把共享层的既有依赖映射到平台适配层，共享层源码保持零改动（唯一例外是 Requirement 2.4 允许的一次性外提）。
3. The system SHALL 复用 `src/storage/**`、`src/prompt/**`、`src/network/**`、`src/apiProtocols/**`、`src/i18n/index.js` + `src/i18n/locales/**`、`src/chat/` 的纯逻辑模块、`src/agent/**`、`src/utils/**`、`src/logging/**`。
4. WHERE 共享层模块因打包器无法执行的语法（ESM 内的 CommonJS `require` 静态资源）而无法复用时，THE system SHALL 通过一次行为等价的外提（把资源加载器抽成可注入模块）解决，并在同一次提交中补齐对应回归测试。
5. The system SHALL 在桌面端复用 `src/chat/useChatSend.js` 与 `src/chat/useSessionMessages.js` 的发送/落盘编排，以保留配置指纹校验、迟到回复丢弃、串行落盘与草稿恢复等既有语义。
6. IF 某共享模块依赖 Android 专属原生能力，THEN the system SHALL 令其能力探测返回不可用，并在界面上显式标注该功能在桌面端不可用。

### Requirement 3：平台适配层契约

**User Story:** 作为开发者，我希望平台差异集中在一层薄适配里，便于测试与后续补齐。

#### Acceptance Criteria

1. The system SHALL 提供 AsyncStorage 等价实现，支持 `getItem`、`setItem`、`removeItem`、`getAllKeys`、`multiGet`、`multiSet`、`multiRemove`，键名与值语义与现有存储层完全一致。
2. The system SHALL 以「一键一文件、临时文件 + 原子重命名」的方式落盘键值数据，使单值体积不受 Android CursorWindow 约 2MB 限制约束。
3. The system SHALL 提供 `expo-file-system/legacy` 等价实现，覆盖现有用到的 `documentDirectory`、`cacheDirectory`、`EncodingType`、`getInfoAsync`、`readAsStringAsync`、`writeAsStringAsync`、`makeDirectoryAsync`、`readDirectoryAsync`、`copyAsync`、`moveAsync`、`deleteAsync`、`downloadAsync`、`getFreeDiskStorageAsync`，以及 `new File(uri).open()/readBytes()/text()/write()/delete()` 分片读取契约。
4. The system SHALL 令 `documentDirectory` 返回带结尾斜杠的 `file://` URL，使共享层的字符串拼接（如 `${documentDirectory}chat-images/`）在 Windows 上仍得到合法 URI。
5. The system SHALL 提供 `expo-secure-store` 等价实现，沿用 `secure:v1:<id>` 引用格式；当系统加密不可用时按现有语义降级为明文并记录诊断。
6. The system SHALL 提供 `Alert` 等价实现，签名兼容 `(title, message?, buttons?)`，按钮回调与取消语义与 React Native 一致。
7. The system SHALL 提供 `Platform` 等价对象，`Platform.OS` 返回 `'windows'`，使既有 `Platform.OS !== 'android'` 的守卫自动关闭 Android 专属能力。

### Requirement 4：聊天主流程

**User Story:** 作为用户，我希望在桌面上像在手机上一样发消息、看流式回复。

#### Acceptance Criteria

1. WHEN 用户发送文本消息，THE system SHALL 立即以非持久化的 pending 占位呈现，并在收到首个增量时替换为流式正文。
2. WHILE 流式回复进行中，THE system SHALL 按增量更新正文与思考内容，且已提交消息部分保持引用稳定以避免整表重渲染。
3. IF 请求失败或超时，THEN the system SHALL 生成带脱敏文本的错误气泡，并保留原始错误于内存供诊断与复制。
4. WHEN 用户在请求进行中切换角色或会话，THE system SHALL 丢弃该请求的迟到回复，且不写入新会话的消息列表。
5. WHEN 用户触发重新生成，THE system SHALL 撤回末条助手回复（或所选分支尾段）并按现有分支归档规则落盘。
6. The system SHALL 支持思考内容折叠展示，并能区分工具调用气泡（首版在无工具模式下不出现）。
7. WHEN 用户在运行中补充指令，THE system SHALL 按现有 steering 语义入队，或在无多轮循环时保留输入并给出说明。

### Requirement 5：模型与接口配置

**User Story:** 作为用户，我希望配置自己的接口地址与密钥。

#### Acceptance Criteria

1. The system SHALL 支持多套 API 配置的增删改与切换，字段与 `src/storage/apiConfigs.js` 保持一致。
2. The system SHALL 支持 `openai`、`openai-responses`、`anthropic` 三种协议，协议实现全部复用 `src/apiProtocols.js`。
3. WHEN 主模型返回 429、5xx、超时、断网或参数被拒，THE system SHALL 按 `fallbackModels` 依次降级并在界面提示「已切换到 X」。
4. WHEN 接口返回的配置指纹与请求发起时不一致，THE system SHALL 丢弃该回复并提示配置已变更。
5. The system SHALL 在保存 `http://` 地址前提示明文传输风险，判定与文案复用现有设置页逻辑。
6. WHEN 用户粘贴或输入密钥，THE system SHALL 仅在界面内受控显示，并在写入磁盘前交给密钥适配层处理。

### Requirement 6：角色与会话管理

**User Story:** 作为用户，我希望管理多个角色与它们的多段对话。

#### Acceptance Criteria

1. The system SHALL 按「索引键 + 单条分键」方式读写角色库与会话列表，键名与迁移逻辑复用现有存储层。
2. WHEN 角色删除，THE system SHALL 通过既有 `onCharacterDeleted` 钩子清理该角色的会话、记忆、作息等从属数据。
3. WHEN 用户切换当前角色，THE system SHALL 同步切换活动会话指针，并在无会话时创建一段新会话。
4. The system SHALL 支持会话置顶、克隆、单条删除与批量删除，且删除时连带清理聊天图片、语音与分支键。
5. IF 会话列表读取失败，THEN the system SHALL 保留原文件不覆盖，并提供「恢复丢失的会话」入口。

### Requirement 7：消息渲染

**User Story:** 作为用户，我希望回复排版好看，富 HTML 角色卡能正常显示。

#### Acceptance Criteria

1. The system SHALL 对助手消息按 Markdown 渲染，对用户消息与错误消息按纯文本渲染。
2. The system SHALL 在渲染前对超长 Markdown 施加既有长度上限并提示截断，防止解析器卡顿。
3. WHEN 消息包含 `<style>`、`<script>`、`<details>`、`<svg>`、`<audio>`、`<video>` 等标签，THE system SHALL 使用受限 iframe 渲染，并通过 CSP 限制外链与脚本来源。
4. The system SHALL 以自定义协议（`easychat2-media://`）加载本地图片与视频，且该协议只解析文档目录内的文件。
5. IF 媒体文件缺失，THEN the system SHALL 渲染占位块并保留消息文本，不因缺图导致整条消息渲染失败。

### Requirement 8：附件与表情包

**User Story:** 作为用户，我希望在桌面上直接拖入图片或选择文件发送。

#### Acceptance Criteria

1. WHEN 用户粘贴、拖入或选择图片，THE system SHALL 将文件复制到 `chat-images/`（视频到 `chat-videos/`），落盘后登记媒体保护，再构造媒体消息。
2. The system SHALL 对附件施加与 Android 端一致的体积与像素上限，超限时给出明确提示并中止发送。
3. The system SHALL 支持从本地图片导入表情包、为其命名，并按白名单解析助手回复中的表情包指令。
4. WHEN 用户录制或播放语音（首版未实现），THE system SHALL 在界面给出「桌面版暂不支持语音」的说明。

### Requirement 9：数据导入导出

**User Story:** 作为用户，我希望把手机上的数据迁到电脑上继续聊。

#### Acceptance Criteria

1. The system SHALL 支持导入 PNG 与 JSON 角色卡，解析、清洗与归一化复用 `src/character/cardParser.js`。
2. The system SHALL 支持导出角色卡与整库备份，备份格式与 `BACKUP_SCHEMA_VERSION = 1` 完全一致。
3. WHEN 导入备份包，THE system SHALL 按现有「合并 / 覆盖」语义写入，覆盖模式不做先删后写。
4. WHEN 备份包内的媒体绝对路径来自其他平台或安装，THE system SHALL 将其重写为当前文档目录下的相对路径后再写入，保证恢复后图片可显示。
5. The system SHALL 保持导入上限 512MB、导出上限 2GB 的现有口径，并在超限时给出可操作的提示。
6. IF 备份文件读取失败，THEN the system SHALL 使用流式分片读取路径，禁止整文件读入内存。
7. The system SHALL 在恢复完成后刷新角色库与会话列表，且不残留 `pending` 占位消息。

### Requirement 10：国际化与外观

**User Story:** 作为用户，我希望界面语言与主题可切换，与手机版一致。

#### Acceptance Criteria

1. The system SHALL 复用 `src/i18n/index.js` 与 `src/i18n/locales/**`，桌面新增文案必须以词条形式加入两种语言。
2. The system SHALL 复用 `src/theme/themes.js` 的主题定义，桌面端新增桌面专属样式令牌时沿用同一命名体系。
3. WHEN 用户切换语言或主题，THE system SHALL 立即生效且无需重启。
4. The system SHALL 支持系统级缩放与高 DPI 显示，界面在 100% 至 200% 缩放下不发生布局重叠。

### Requirement 11：质量门禁

**User Story:** 作为维护者，我希望桌面代码同样受既有门禁约束。

#### Acceptance Criteria

1. The system SHALL 使 `npm test` 继续覆盖共享层，并为桌面纯逻辑提供独立测试命令。
2. The system SHALL 把桌面源码纳入 ESLint 检查，并纳入「用户可见文案禁止硬编码中文」规则范围。
3. The system SHALL 为桌面源码设置独立的行数基线与根文件上限校验，不放松 Android 侧既有阈值。
4. The system SHALL 为平台适配层提供行为测试，覆盖原子写入、路径越界拒绝、分片读取跨片多字节字符、`file://` 与系统路径互转。
5. IF 桌面纯逻辑覆盖率低于 60%，THEN the system SHALL 使覆盖率命令失败。

### Requirement 12：打包与分发

**User Story:** 作为发布者，我希望 CI 能产出 Windows 安装包。

#### Acceptance Criteria

1. The system SHALL 通过 `electron-builder` 产出 Windows x64 NSIS 安装包与免安装压缩包。
2. The system SHALL 在 CI 中以 `windows-latest` 运行构建，并上传产物为可下载工件。
3. The system SHALL 保持 Android 构建配置（`app.json`、`plugins/**`、`eas.json`）不变。
4. WHEN 桌面构建失败，THE CI SHALL 明确区分是渲染层构建失败还是主进程打包失败。

## Constraints

- 首版不改动 `app.json`、`plugins/**`、`android/`（生成目录）与现有 Android 构建脚本。
- 桌面端不得在渲染进程使用 Node API；所有文件与网络能力经 IPC 收口。
- 桌面新增代码遵守仓库既有约定：ESM、相对导入带 `.js` 扩展名、目录导入写 `index.js`、用户可见文案走 `t()`、不新增全局可变状态。
- Rust/Go/Python 工具链不在首版引入；一切系统能力由 Node 与 Electron 提供。
- 单文件行数上限 800 行、新文件按领域归目录，两条规则同样适用于 `desktop/`。

## Compatibility and Migration

1. 存储键名、值结构与版本迁移路径与 Android 端完全一致，手机备份可在桌面恢复。
2. 跨平台媒体路径：Android 存储的 `file:///data/user/0/<pkg>/files/chat-images/x.jpg` 在桌面恢复时必须重写为 `file:///C:/.../EasyChat2/chat-images/x.jpg`。
3. 桌面端新增的键（如窗口尺寸、桌面偏好）使用 `@easychat2_desktop_*` 前缀，Android 端读到未识别键时保持忽略，不参与备份白名单。
4. 备份白名单新增键必须同步更新 `src/storage/dataBackup.js` 的清单与对应测试。

## Open Questions

1. 是否需要支持从桌面反向导出到手机（当前设计为同一备份格式双向可用，无需额外格式）。
2. 首版是否包含自动更新（默认不含，先做手动下载安装）。
3. 代码签名证书是否本期提供（无证书则发布未签名安装包，Windows SmartScreen 会提示）。
