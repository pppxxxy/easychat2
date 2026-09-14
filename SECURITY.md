# 安全与隐私声明

本声明说明 EasyChat2 如何处理数据、使用哪些权限与依赖、以及明文传输等风险。请在使用前完整阅读。

## 1. 数据与隐私：本地优先，不收集

- 本项目没有自建后端、没有账号体系，源码中**唯一的网络请求**是 `src/api.js` 向你自行配置的第三方 API 地址发送聊天请求。
- 未接入任何分析、广告或遥测 SDK；开发者不接收、不存储、不转售你的任何数据。
- 所有状态保存在设备本地（AsyncStorage），键名如下：

  | 存储键 | 内容 |
  |--------|------|
  | `@easychat2_api_config` | API 地址、模型名、**API Key（明文）** |
  | `@easychat2_character` | 当前角色、世界书与正则脚本 |
  | `@easychat2_messages::<characterId>` | 该角色的聊天记录（默认角色兼容旧键 `@easychat2_messages`） |

- 卸载应用或清除应用数据即可删除上述内容。开发者侧没有可删除的副本。
- 需要留意的本地风险：
  - API Key 以明文 JSON 存在 AsyncStorage，未做额外加密。Android 的应用私有目录受系统沙箱保护，但 root / 越狱设备、或调试工具仍可能读取。
  - 应用已设置 `android:allowBackup="false"`，系统云备份不会包含应用数据（含 API Key）。

## 2. 第三方 API 披露

EasyChat2 不代理、不中转请求。发送消息时，以下内容会**直接**发送到你填写的 API 地址（默认 `https://api.deepseek.com`）：

- 系统提示词（由角色名、描述、性格、场景、系统提示词、历史后指令合成）
- 命中的世界书条目
- 历史消息与当前输入
- 模型名
- HTTP 头 `Authorization: Bearer <你的 API Key>`

该地址的实际运营方决定其日志、留存、数据地域与合规策略，均与本项目开发者无关。请在使用前阅读对应服务商的隐私政策与服务条款，并自行确认其可信度。默认值仅作示例，你可以指向任意兼容 OpenAI Chat Completions 的服务。

## 3. 用户内容与责任

- 你导入的角色卡、世界书、正则脚本以及聊天内容，其合法性与权利归属由你自行负责：
  - 确认拥有或已获授权使用导入的内容；
  - 遵守原卡片作者的许可（第三方角色卡常附带作者使用条款）；
  - 不发布或传播违法、侵权或有害内容。
- 你需遵守所选 API 服务商的使用政策，并自行承担调用产生的费用、限流或账号风险。
- 模型生成内容可能不准确或有偏差，请自行判断，勿作为专业意见依据。

## 4. 免责声明：按现状提供，无担保

本项目以 AGPL-3.0-or-later 授权，按“现状（AS IS）”提供，不附带任何明示或默示的担保，包括但不限于适销性、特定用途适用性与不侵权担保。在法律允许的最大范围内，作者不对因使用或无法使用本软件造成的任何损失负责，包括数据丢失、费用支出、账号受限、内容或合规问题。完整条款见 [LICENSE](./LICENSE)。

## 5. Android 权限说明

应用不主动申请任何运行时权限。`app.json` 中的 `android.permissions` 为空，并通过 `android.blockedPermissions` 排除由原生库引入的存储权限：

| 权限 | 处理 |
|------|------|
| `READ_EXTERNAL_STORAGE` | 已排除（角色卡导入走系统文件选择器，无需该权限） |
| `WRITE_EXTERNAL_STORAGE` | 已排除 |
| `READ_MEDIA_IMAGES` | 已排除（不读取系统图库） |

经 `expo prebuild` 生成后，清单中保留的权限为：

| 权限 | 来源与用途 |
|------|-----------|
| `INTERNET` | 发送 API 请求所必需 |
| `SYSTEM_ALERT_WINDOW`、`VIBRATE` | Expo / React Native 模板默认值，非本应用功能所需；如需可继续通过 `blockedPermissions` 排除（`SYSTEM_ALERT_WINDOW` 与开发菜单相关，请在真机上验证后再决定） |

其他加固：

- `android:allowBackup="false"`，避免 API Key 等数据进入系统备份。
- 角色卡导入使用 Storage Access Framework，不需要存储权限。
- 建议在每次发布前核对 release 包的实际清单，确认没有额外被引入的权限。
- iOS 侧无自定义权限声明。

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
| `@babel/core`（devDependency） | 构建转译 |

建议定期执行 `npm audit` 并关注上游安全公告。

## 7. HTTP 明文传输风险

- 设置页允许填写 `http://` 地址，保存前会二次确认（见 `src/SettingsScreen.js`）。
- 风险：在明文连接下，**API Key 与全部对话内容**可能被同一网络下的第三方窃听或篡改。请始终优先使用 `https://`。
- Android 9（API 28）及以上默认禁止明文流量，本项目的 `app.json` 未配置 `usesCleartextTraffic`，因此 release 包通常**无法**真正使用 `http://`（会表现为网络错误）。确实需要时须自行配置原生属性，并理解随之而来的风险。
- 报错信息在展示与复制前会经 `src/secrets.js` 的 `maskSecrets` 屏蔽 `sk-...` 与 `Bearer ...`，但仍可能包含其他上下文，公开分享日志前请再次检查。
- 本地聊天记录与 API 配置均以明文 JSON 存储，未加密。

## 8. 漏洞报告

发现安全问题请通过仓库 Issues 反馈（https://github.com/pppxxxy/easychat2/issues），或按仓库主页提供的联系方式私下沟通。请勿在公开 Issue 中粘贴真实 API Key 或他人隐私数据。