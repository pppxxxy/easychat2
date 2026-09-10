# EasyChat2

EasyChat2 是一个基于 Expo + React Native 的移动端 AI 聊天应用。

## 本地运行

```bash
npm install
npm run start
```

用 Expo Go 扫码即可在真机上调试。

## 设置 API

打开 App 后进入「设置」页面，填写以下三项并保存：

| 字段 | 说明 |
|------|------|
| **API 地址** | 兼容 OpenAI 格式的 API 端点，例如 `https://api.openai.com/v1` |
| **模型** | 模型名称，例如 `gpt-4o`、`deepseek-chat` 等 |
| **API Key** | 对应的 API 密钥 |

> 如果 API 地址使用 `http://` 协议（而非 `https://`），保存时会弹出二次确认——未加密传输下 API Key 存在明文泄露风险。

填写完毕后返回聊天页，即可发送消息开始对话。

## APK 构建

仓库提供两条构建路径，都需要在 GitHub Actions 里手动触发（`workflow_dispatch`）：

1. **Build APK on GitHub**：在 GitHub runner 上 `prebuild` + Gradle 打 release APK，不依赖 EAS。构建完成后从 Actions 的 Artifacts 下载。
2. **Build APK**：调用 Expo EAS 云构建。需要在仓库 Secrets 中配置 `EXPO_TOKEN`。

本地也可以打预览包（需先全局安装 EAS CLI）：

```bash
npm install -g eas-cli
npm run build:apk
```
