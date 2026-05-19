# EasyChat2

EasyChat2 是一个基于 Expo + React Native 的移动端 AI 聊天应用。

## APK 构建

本仓库使用 GitHub Actions 调用 Expo EAS 构建 Android APK。

需要在仓库 Secrets 中配置以下任一方式：

- 推荐：`EXPO_TOKEN`
- 或：`EXPO_USERNAME` + `EXPO_PASSWORD`

推送到 `main` 分支或手动触发 Actions 后，会开始构建 APK。

## 本地运行

```bash
npm install
npm run start
```
