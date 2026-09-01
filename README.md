# EasyChat2

EasyChat2 是一个基于 Expo + React Native 的移动端 AI 聊天应用。

## 本地运行

```bash
npm install
npm run start
```

用 Expo Go 扫码即可在真机上调试。请先在「设置」页填写 API 地址、模型和 API Key。

## APK 构建

仓库提供两条构建路径，都需要在 GitHub Actions 里手动触发（`workflow_dispatch`）：

1. **Build APK on GitHub**：在 GitHub runner 上 `prebuild` + Gradle 打 release APK，不依赖 EAS。构建完成后从 Actions 的 Artifacts 下载。
2. **Build APK**：调用 Expo EAS 云构建。需要在仓库 Secrets 中配置 `EXPO_TOKEN`。

本地也可以打预览包（需先全局安装 EAS CLI）：

```bash
npm install -g eas-cli
npm run build:apk
```
