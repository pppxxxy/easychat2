# EasyChat2 Desktop (S1 skeleton)

Windows 桌面版（Electron 外壳 + React DOM 界面）。需求与设计见
[`.monkeycode/specs/2026-11-11-windows-desktop/`](../.monkeycode/specs/2026-11-11-windows-desktop/)。

## 当前阶段：S3（聊天主流程：文本收发 + 流式 + 落盘）

- `electron/`：主进程（窗口、键值仓、文件、密钥、流式 HTTP、媒体协议、对话框、
  内置角色素材复制）。
- `src/platform/`：渲染层适配层，是共享层 `src/` 的 import 落点（别名表见 `vite.config.mjs`）。
- `src/provider/DesktopApp.jsx`：逐字复用 AppContext / I18nContext / ThemeContext 的
  桌面界面骨架——角色列表（头像经 `easychat2-media://`）、会话列表、聊天（文本收发/
  流式/重新生成）、语言与主题切换、应用内 Alert。
- `src/provider/useDesktopChat.js`：复用 useSessionMessages + useChatSend 的发送/落盘编排
  （配置指纹、迟到回复丢弃、串行落盘、草稿恢复），桌面不支持的能力收敛为 no-op。
- `tests/`：适配层行为测试（纯 Node）；`npm run smoke` 在真实 Electron 里做全链路
  探测并截图（S1+S2 验收物）。
- S4 接入 Markdown/富 HTML/附件/贴纸与媒体渲染；S5 做导入导出与跨端媒体路径重写
  （手机↔桌面双向）；S6 打包与 Windows CI。

## 命令

```bash
npm install                    # 首次；本仓库惯用 --ignore-scripts（跳过 electron 二进制下载）
npm run dev                    # Vite dev server（需在另一终端起 Electron 并设置 VITE_DEV_SERVER_URL）
npx vite build                 # 渲染层构建
node --test tests/             # 适配层行为测试
npm run smoke                  # 真实 Electron 全链路冒烟（截图写到 <userData>/smoke.png）
npm run dist                   # Windows NSIS + zip（需在 Windows 机器 / CI 上执行）
```

## 与 Android 的关系

- 根 `package.json` 的 `main` 仍指向 Expo 入口；`desktop/` 是独立 package，
  Android 构建链（`app.json`、`plugins/**`、`eas.json`）完全不受影响。
- 共享层 `src/` 源码零改动；平台差异只出现在 `desktop/src/platform/**` 与
  `desktop/electron/**`。
- 数据格式与 Android 完全一致（同一套存储键、`schemaVersion: 1` 备份包），
  手机备份可在桌面恢复；媒体路径在跨端恢复时按已知目录名重写。

## 已知边界（S1）

- 容器内无图形会话：只能验证 `vite build` 与 Node 测试；Electron 窗口与安装包
  需在 Windows 机器上验证。
- `electron` 依赖用 `npm install --ignore-scripts` 安装时不会下载二进制，
  `npm run dev`/`dist` 前需要在目标机器重新安装或手动补 `electron` 二进制。
