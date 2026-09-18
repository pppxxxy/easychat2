# 需求实施计划

- [x] 1. 依赖与打包
  - [x] 1.1 安装 `react-native-webview`（Expo SDK 50 兼容版本 13.6.4）（设计「依赖」）
  - [x] 1.2 `npm ci --dry-run` 确认锁文件同步（构建与配置）

- [x] 2. 内置小游戏
  - [x] 2.1 `src/games/games.js`：游戏清单 `[{ id, name, description, html }]`，HTML 以字符串常量内嵌（需求 2.3）
  - [x] 2.2 内置猜数字、贪吃蛇、打砖块三个纯前端无网络游戏（需求 2.1、2.2）

- [x] 3. 检查点 - 确保所有可运行验证通过

- [x] 4. 扩展页
  - [x] 4.1 `src/ExtensionScreen.js`：顶部分段控件切换「游戏」与「生图」（需求 1.2）
  - [x] 4.2 游戏列表展示名称与说明，选中后用 `WebView` 加载对应 HTML，顶部提供返回列表（需求 2.3）
  - [x] 4.3 生图内联渲染 `ImageGenScreen`（`embedded`），切换分段不丢失已填内容（需求 3.1、3.2）
  - [x] 4.4 WebView 加载失败展示「加载失败」与重试；`react-native-webview` 不可用时隐藏游戏入口并提示（设计「错误处理」、正确性属性 4）

- [x] 5. 检查点 - 确保所有可运行验证通过

- [x] 6. 底部导航接入
  - [x] 6.1 `App.js` 在「角色」与「设置」之间新增「扩展」Tab 与图标（需求 1.1、4.1）

- [x] 7. 回归与文档
  - [x] 7.1 脚本验证游戏清单结构与 HTML 内联无网络（设计「测试策略」）
  - [x] 7.2 打包验证 `npx expo export --platform android`（重点验证 WebView 原生依赖）
  - [x] 7.3 同步 `.monkeycode/docs/` 扩展页与游戏模块章节