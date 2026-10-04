# 安全与隐私声明

本声明说明 EasyChat2 如何处理数据、使用哪些权限与依赖、以及明文传输等风险。请在使用前完整阅读。

## 1. 数据与隐私：本地优先，不收集

- 本项目没有自建后端、没有账号体系；网络请求由你配置的第三方服务处理，聊天请求来自 `src/api.js`，生图、向量记忆、TTS、联网搜索和设置页检测也可能在用户主动启用或操作时访问对应服务。
- 未接入任何分析、广告或遥测 SDK；开发者不接收、不存储、不转售你的任何数据。应用内的「诊断日志」仅把异常信息脱敏后保存在本机（`@easychat2_diagnostics`），供你自行查看与复制，不会上传到任何服务器。
- 元数据与设置保存在设备本地 AsyncStorage；聊天图片、表情包和大型角色正文使用应用文档目录文件，键名与文件目录如下：

  | 存储键 | 内容 |
  |--------|------|
   | `@easychat2_api_config` | 旧版单 API 配置，仅迁移读取 |
   | `@easychat2_api_configs` | 多套 API 配置（API Key 存于系统安全存储，本键只留引用） |
   | `@easychat2_character_index` + `@easychat2_character_item::<id>` | 角色库、世界书与正则脚本 |
   | `@easychat2_messages::<sessionId>` | 会话消息（旧的按角色/单会话键仅迁移读取） |
   | `@easychat2_session_draft::<sessionId>` | 会话级输入框草稿（仅开启「保留输入草稿」时写入） |
   | `@easychat2_sticker_index` + `@easychat2_sticker_item::<id>` | 表情包元数据 |
   | `@easychat2_moments`、`@easychat2_diary_item::<id>`、`@easychat2_world_map`、`@easychat2_affinity` | 动态、日记、世界地图与好感度 |
   | `@easychat2_vector_memory_configs`、`@easychat2_vector_index::<characterId>` | 向量记忆配置与本地索引（含消息片段向量） |
   | `@easychat2_tts`、`@easychat2_transcription`、`@easychat2_image_gen`、`@easychat2_plugins` | TTS / 转写 / 生图 / 搜索配置（密钥存于系统安全存储，本键只留引用） |
   | `@easychat2_local_model_index` + `@easychat2_local_model_item::<id>` | 本地模型条目与参数（模型文件本身也存于本机文档目录） |
   | `@easychat2_proactive_settings` | 主动消息槽位设置（原生侧另用 EncryptedSharedPreferences 存一份） |
   | `@easychat2_music_index` + `@easychat2_music_item::<id>`、`@easychat2_music_comments::<songId>` | 本地音乐库（曲库与时间轴打点）与听歌陪伴评论（评论只在面板内呈现，不进聊天会话） |
   | `@easychat2_books_index` + `@easychat2_books_item::<id>`、`@easychat2_book_comments::<bookId>` | 本地书架（书目、阅读进度与目录）与陪读评论（评论只在面板内呈现，不进聊天会话） |
   | `@easychat2_screen_watch_comments` | 看屏幕评论（含对应截图的本机路径；评论只在面板内呈现，不进聊天会话） |
   | `@easychat2_workspace` | 工作区设置（模式 ask/read/write、工作区文件夹位置、命令执行开关）；沙盒文件本身存于本机（默认 `documentDirectory/workspace/`，或你在设置里选择的外部文件夹），不在此键 |
   | `@easychat2_location` | 真实位置开关、最近一次成功位置（经纬度与反地理编码描述）与可选瓦片模板；关闭时不取点、不注入对话 |
   | `@easychat2_diagnostics` | 诊断日志（最近 50 条脱敏异常），仅本机、不上报 |
   | `documentDirectory/chat-images/`、`documentDirectory/stickers/` | 图片与表情包文件 |
   | `documentDirectory/voice/`、`documentDirectory/music/`、`documentDirectory/books/` | 语音消息与角色语音音频文件、导入的本地音乐文件、导入的本地书籍文件 |
   | `documentDirectory/screen-watch/` | 看屏幕的截图（临时运行文件：滚动保留最近 20 张自动清扫；**不进备份**） |
   | `documentDirectory/characters/`、`documentDirectory/card-forge/` | 超大角色正文与制卡草稿的大字段文件 |

- 卸载应用或清除应用数据即可删除上述内容。开发者侧没有可删除的副本。导出的备份包由你自行保管，包含角色、会话、消息与媒体；密钥字段在导出时一律置空。
- 需要留意的本地风险：
  - API Key 存于系统安全存储（Android Keystore / iOS Keychain，`expo-secure-store`），AsyncStorage 只保留引用 `secure:v1:<id>`，不再明文保存。安全存储不可用的旧设备（如未配置锁屏的模拟器）会透明降级为明文，此时应用私有目录受系统沙箱保护，但 root / 越狱设备、或调试工具仍可能读取。
  - 应用已设置 `android:allowBackup="false"`，系统云备份不会包含应用数据（含 API Key）。

### 1.1 工作区：文件存放位置与命令执行（请重点阅读）

工作区默认落在应用私有目录 `documentDirectory/workspace/<角色目录>/`，卸载即清除。你可以在「设置 → 工作区 → 工作区文件夹」把它改到**手机上的一个文件夹**（Android 用系统文件夹选择器 SAF，iOS 用文件 App；授权随系统记录，Android 上重启后仍有效）。

- **外部文件夹的授权范围**：一旦你选定某个文件夹，应用获得的是**该文件夹及其全部子目录**的读写权限（这是系统 SAF 的授权粒度，不是应用自己放宽的）。角色文件写在其中的 `<角色目录>/` 里，但技术上应用对该文件夹的其余内容同样有读写能力。请只选择你愿意让本应用读写的文件夹；随时可以在同一处点「恢复默认」收回。
- **应用不会自动扫描该文件夹**：只在你的对话触发工作区工具时按路径读写，不会遍历或上传其它文件。
- **命令执行（run_shell）默认关闭**，需在「设置 → 工作区」单独开启，且开启时会有一个明确的风险确认弹框。开启后：
  - 模型生成的 shell 命令会**在你的设备上真实执行**，可以读取、修改或**删除**应用沙盒内的工作区文件，并可能联网（取决于命令内容）；
  - **每条命令执行前都会单独弹框**并显示完整命令原文，你点「拒绝」或关闭弹框则绝不执行；点「停止生成」会立即终止正在运行的命令；
  - 命令的工作目录限定在应用私有工作区（`workspace/<角色目录>/`）。**没有 root 权限的 shell 访问不到你选择的外部文件夹**，因此选了外部文件夹时该功能不注册、开关不可用；
  - 它只能访问应用自己的沙盒与 `/system/bin` 等公开路径，**不是手机上的完整终端**，也无法读取其它应用的数据。
- 只在你信任当前角色与所配置的模型时开启命令执行。即使有逐条确认，模型仍可能构造出你看不懂但有害的命令（例如把整个工作区删掉）——请把每条确认弹框当作真实的授权决定来读。

## 2. 第三方 API 披露

EasyChat2 不代理、不中转请求。发送消息时，以下内容会**直接**发送到你填写的 API 地址（默认 `https://api.deepseek.com`）：

- 系统提示词（由角色名、描述、性格、场景、系统提示词、历史后指令合成；**开启「真实位置」时另含一行当前位置描述**）
- 命中的世界书条目
- 历史消息与当前输入
- 模型名
- 鉴权头：OpenAI 系为 `Authorization: Bearer <你的 API Key>`；Anthropic 协议为 `x-api-key: <你的 API Key>` 与 `anthropic-version`

该地址的实际运营方决定其日志、留存、数据地域与合规策略，均与本项目开发者无关。请在使用前阅读对应服务商的隐私政策与服务条款，并自行确认其可信度。默认值仅作示例，你可以指向任意兼容的服务。可在「设置 → API 配置」中选择三种协议：**OpenAI Chat Completions**（`/v1/chat/completions`）、**OpenAI Responses**（`/v1/responses`）与 **Anthropic Messages**（`/v1/messages`）；切换协议时按协议使用对应的端点、鉴权头与请求格式。

请仅使用各平台官方提供的 API 服务。EasyChat2 不提供任何共享 API Key、代理地址、中转接口或非官方接口。使用非官方渠道、共享密钥或代理服务产生的一切后果，由用户自行承担。

## 3. 用户内容与责任

- 你导入的角色卡、世界书、正则脚本以及聊天内容，其合法性与权利归属由你自行负责：
  - 确认拥有或已获授权使用导入的内容；
  - 遵守原卡片作者的许可（第三方角色卡常附带作者使用条款）；
  - 不发布或传播违法、侵权或有害内容。
- 你需遵守所选 API 服务商的使用政策，并自行承担调用产生的费用、限流或账号风险。
- 模型生成内容可能不准确或有偏差，请自行判断，勿作为专业意见依据。

## 4. 免责声明：按现状提供，无担保

本项目以 Apache-2.0 授权，按“现状（AS IS）”提供，不附带任何明示或默示的担保，包括但不限于适销性、特定用途适用性与不侵权担保。在法律允许的最大范围内，作者不对因使用或无法使用本软件造成的任何损失负责，包括数据丢失、费用支出、账号受限、内容或合规问题。完整条款见 [LICENSE](./LICENSE)。

### 适用人群与法律合规告知

根据《生成式人工智能服务管理暂行办法》《未成年人网络保护条例》等相关法律法规，本应用作为拟人化 AI 互动服务，依法不向未成年人提供虚拟伴侣、虚拟亲属等亲密关系类服务；向不满十四周岁未成年人提供其他拟人化互动服务的，应当取得监护人同意。用户应自行确认其使用行为符合所在地法律法规。

本告知为法律合规声明，不构成对 Apache-2.0 许可证条款的修改或附加限制。本应用仍以 Apache-2.0 授权，许可证授予的权利不受本告知影响。

## 5. Android 权限说明

应用使用系统文件选择器和系统图片选择器，不申请传统存储权限；**拍照附件功能需要相机权限**（见下）。`expo-image-picker` 声明图片选择与相机的用途文案，Android 的传统读写媒体权限通过 `blockedPermissions` 排除：

| 权限 | 处理 |
|------|------|
| `READ_EXTERNAL_STORAGE` | 已排除，角色卡和附件走系统选择器 |
| `WRITE_EXTERNAL_STORAGE` | 已排除 |
| `READ_MEDIA_IMAGES`、`READ_MEDIA_VIDEO` | 已排除，图片由系统选择器按用户选择返回 |
| `MODIFY_AUDIO_SETTINGS` | 已排除 |

**麦克风（`RECORD_AUDIO`）**：语音消息功能需要，由 `expo-audio` 插件声明（`recordAudioAndroid:true`），用途文案为「录制语音消息需要访问麦克风」。仅在首次点麦克风录音时由系统弹窗请求；拒绝后不启动录音，其他功能不受影响。**不使用语音消息即不会请求该权限。**

**相机（`CAMERA`）**：聊天页「添加附件 → 拍照」功能需要，由 `expo-image-picker` 插件声明，用途文案为「拍摄照片发送到聊天」（iOS 对应 `NSCameraUsageDescription`）。仅在首次点「拍照」时由系统弹窗请求；拒绝后不打开相机并提示到系统设置开启，从相册选图、语音等其他功能不受影响。**不使用拍照即不会请求该权限。**注意：**曾装过 `cameraPermission:false` 旧版本的设备**，插件当时把 CAMERA 写成了屏蔽权限（`tools:node="remove"`），必须卸载重装（或覆盖安装新 release）后系统设置里才会出现相机开关。

**定位（`ACCESS_COARSE_LOCATION`、`ACCESS_FINE_LOCATION`）**：真实位置功能需要，由 `expo-location` 插件声明，用途文案为「获取当前位置，让角色知道你在哪，并在真实地图上标注（仅在使用时）」（iOS 对应 `NSLocationWhenInUseUsageDescription`）。**仅前台、仅在使用时**获取；仅在「扩展 → 世界 → 地图 → 真实地图」中首次开启时由系统弹窗请求，拒绝后保持关闭并提示，网格地图等其他功能不受影响。关闭开关即停止取点并在界面上清除标注。**不开启真实位置即不会请求该权限、不会获取任何位置数据。**

**主动消息与通知**：开启主动消息后，由 `withProactiveMessage` 插件声明下列权限（不开启该功能则不占用）：

| 权限 | 用途 |
|------|------|
| `POST_NOTIFICATIONS` | 到点发送通知（Android 13+ 需用户授权） |
| `RECEIVE_BOOT_COMPLETED` | 重启后重新排定闹钟，避免计划丢失 |
| `SCHEDULE_EXACT_ALARM` | 按设定时刻精确触发 |
| `FOREGROUND_SERVICE`、`FOREGROUND_SERVICE_DATA_SYNC` | 触发时短时前台服务完成消息落库 |

经 `expo prebuild` 生成后，清单中保留的权限为：

| 权限 | 来源与用途 |
|------|-----------|
| `INTERNET` | 发送 API 请求所必需（`withLocalApiServer` 亦声明，用于本机回环服务） |
| `POST_NOTIFICATIONS`、`RECEIVE_BOOT_COMPLETED`、`SCHEDULE_EXACT_ALARM`、`FOREGROUND_SERVICE`、`FOREGROUND_SERVICE_DATA_SYNC` | 主动消息（见上表） |
| `RECORD_AUDIO` | 语音消息录音（见上） |
| `CAMERA` | 拍照附件（见上） |
| `ACCESS_COARSE_LOCATION`、`ACCESS_FINE_LOCATION` | 真实位置（前台、仅在使用时，见上） |
| `SYSTEM_ALERT_WINDOW`、`VIBRATE` | Expo / React Native 模板默认值，非本应用功能所需；如需可继续通过 `blockedPermissions` 排除（`SYSTEM_ALERT_WINDOW` 与开发菜单相关，请在真机上验证后再决定） |

其他加固：

- `android:allowBackup="false"`，避免 API Key 等数据进入系统备份。
- 角色卡导入使用 Storage Access Framework，不需要存储权限。
- 工作区文件读写默认限定在应用私有沙盒（`workspace/<角色目录>/`），路径规范化后拒绝 `..`、绝对路径与非白名单扩展名；改选外部文件夹时改为 SAF 逐 URI 访问（见 §1.1），同样不需要传统存储权限。
- 命令执行使用独立原生模块（`ShellExecutor`，起 `/system/bin/sh -c` 子进程），**不声明任何额外权限**：它只继承应用自身的沙盒权限，无法越过应用边界。
- 建议在每次发布前核对 release 包的实际清单，确认没有额外被引入的权限。
- iOS 侧声明图片库用途文案（系统图片选择器）、相机用途文案（拍照附件）与麦克风用途文案（语音消息录音），均在对应功能首次使用时由系统弹窗请求。

## 5.5 各功能向第三方发送的内容

除聊天请求外，以下功能在你主动使用时会把你指定的内容直接发往**你自己配置的**对应服务商。开发者不参与、不记录、不中转这些请求：

| 功能 | 发送内容 | 默认是否启用 |
|------|---------|------------|
| 聊天（含群聊） | 系统提示词、命中的世界书、历史消息与输入（**含图片附件**——拍照、相册选图与表情包在开启识图时以多模态内容发送）、模型名、`Authorization` 头 | 配置 API 后即启用 |
| 一起听歌（陪伴评论） | 系统提示词、用户档案与全局预设、歌曲名与当前进度（不含音频内容本身） | 扩展 → 世界 → 听歌，打点或开播时 |
| 一起看书（陪读评论） | 系统提示词、用户档案与全局预设、书名与当前页的段落摘录（仅文字，至多约 600 字） | 扩展 → 世界 → 看书，点「让TA聊聊这一页」时 |
| 看屏幕（陪伴评论） | 系统提示词、用户档案与全局预设、**当前屏幕截图（仅本应用画面）** | 扩展 → 世界 → 看屏幕，点「截屏给TA看看」时 |
| 真实位置 | 当前位置的经纬度与反地理编码得到的地点描述，开启后随聊天的系统提示一并发往**你自己配置的模型服务**；**瓦片底图请求由 WebView 直接发往地图服务商（默认高德）**，不含聊天内容与 API Key | 关闭，需手动开启并授权定位 |
| 对话配图 / 生图 | 提示词、可选的原图（图生图） | 关闭，需手动开启 |
| 语音播报（TTS） | 待朗读的回复文本（经清洗去 Markdown） | 关闭 |
| 语音转写 | 录音音频文件 | 发送语音时 |
| 向量记忆 | 消息片段（建索引）与检索词（召回） | 关闭 |
| 联网搜索 | 命中的搜索关键词 | 关闭 |
| 本地模型 | 不外发（推理在本机完成） | 关闭 |
| 本地 API 服务 | 不外发；仅在 `127.0.0.1` 监听，供同机客户端调用，强制 Bearer 鉴权 | 关闭 |

请勿在上述任何内容中发送身份证号、银行卡号、密码等个人敏感信息。发送前请阅读对应服务商的隐私政策。

## 6. 依赖与数据行为

以下为 `package.json` 的直接依赖及用途，均未发现内嵌分析或追踪行为。实际版本与传递依赖以 `package-lock.json` 为准。

| 依赖 | 用途 |
|------|------|
| `@react-native-async-storage/async-storage` | 本地键值存储 |
| `@react-navigation/native`、`/bottom-tabs`、`/native-stack` | 页面导航 |
| `buffer` | `parsecard` 需要的全局 `Buffer` 垫片 |
| `expo` | 运行框架 |
| `expo-clipboard` | 复制报错文本 |
| `expo-document-picker` | 选择角色卡 PNG / JSON 文件 |
| `expo-file-system` | 读取所选文件内容 |
| `expo-status-bar`、`expo-system-ui` | 状态栏与系统 UI |
| `graphql` | 运行时未直接引用；`@expo/cli`（构建期）需要，固定版本以稳定解析 |
| `parsecard` | 解析角色卡 PNG / JSON |
| `react`、`react-native` | 基础框架 |
| `react-native-gesture-handler`、`react-native-screens`、`react-native-safe-area-context` | 手势、原生屏幕与安全区 |
| `react-native-markdown-display` | 渲染助手 Markdown 回复 |
| `react-native-vector-icons` | 图标 |
| `@babel/core`、`@babel/preset-env`（devDependency） | 构建转译与 Node 测试运行 |
| `expo-image-picker`、`expo-image-manipulator` | 选择、缩放和处理本地图片/表情包 |
| `expo-location` | 获取前台位置与反地理编码（真实位置功能） |

建议定期执行 `npm audit` 并关注上游安全公告。

## 7. HTTP 明文传输风险

- 设置页允许填写 `http://` 地址，保存前会二次确认（见 `src/SettingsScreen.js`）。
- 风险：在明文连接下，**API Key 与全部对话内容**可能被同一网络下的第三方窃听或篡改。请始终优先使用 `https://`。
- Expo Android 模板默认写入 `android:usesCleartextTraffic="true"`；本项目未显式关闭它，因此 release 包是否允许明文请求取决于生成后的 Manifest 与目标系统策略——发布前请核对实际清单，并在确认所有服务均为 `https://` 后优先禁用明文流量。
- 报错信息在展示与复制前会经 `src/secrets.js` 的 `maskSecrets` 屏蔽 `sk-...` 与 `Bearer ...`，但仍可能包含其他上下文，公开分享日志前请再次检查。
- 本地聊天记录与 API 配置均以明文 JSON 存储，未加密。

## 8. 漏洞报告

发现安全问题请通过仓库 Issues 反馈（https://github.com/pppxxxy/easychat2/issues），或按仓库主页提供的联系方式私下沟通。请勿在公开 Issue 中粘贴真实 API Key 或他人隐私数据。