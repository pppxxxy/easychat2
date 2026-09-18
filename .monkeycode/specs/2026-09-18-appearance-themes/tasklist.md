# 需求实施计划

- [x] 1. 主题基础
  - [x] 1.1 `src/theme/themes.js`：五套预设主题（深色 / 浅色 / 蓝色 / 粉红色 / 深红色）与语义令牌（需求 1.2、1.5、2.2）
  - [x] 1.2 `src/theme/ThemeContext.js`：`ThemeProvider` 加载并持久化外观设置，`useTheme` 提供主题、字体缩放与 `scaled`（需求 1.3、2.4）
  - [x] 1.3 六档字体（默认 / 跟随系统 / 小 / 中 / 大 / 特大）与 `resolveFontScale`（需求 3.2、3.4）
  - [x] 1.4 `storage.js` 新增 `getAppearanceSettings` / `saveAppearanceSettings`（键 `@easychat2_appearance`），非法值回退默认（需求 1.4、3.5）

- [x] 2. 检查点 - 确保所有可运行验证通过

- [x] 3. 入口接入
  - [x] 3.1 `App.js` 接入 `ThemeProvider`，Header、导航主题、状态栏与 TabBar 随主题变化（需求 2.1）
  - [x] 3.2 设置页新增「外观」卡片：五套主题色块选择（需求 1.1、1.3）
  - [x] 3.3 设置页新增「字体大小」六档 chips（需求 3.1、3.3）

- [x] 4. 页面迁移
  - [x] 4.1 Migrate `ChatScreen`（含 MessageBubble / ErrorBubble / ThinkingIndicator 与 Markdown/HTML 样式）
  - [x] 4.2 迁移 `MemoryScreen` / `SearchScreen` / `ScrollScrubber`（含 `RowAction` 子组件）
  - [x] 4.3 迁移 `CharacterScreen`
  - [x] 4.4 迁移 `SettingsScreen` / `PluginPanel` / `PresetPanel`
  - [x] 4.5 迁移 `ExtensionScreen` / `ImageGenScreen` / `disclaimer.js`
  - [x] 4.6 各屏 `StyleSheet.create` 改为 `createStyles(theme, fonts)`，硬编码字号改用 `fonts.scaled`（需求 4.1、4.2、4.3）

- [x] 5. 检查点 - 确保所有可运行验证通过

- [x] 6. 回归与文档
  - [x] 6.1 脚本验证：五套主题令牌完整性与合法性、六档字体与 `resolveFontScale`、外观设置默认/回退/补默认（设计「测试策略」）
  - [x] 6.2 静态检查：目标文件不再出现默认主题硬编码色值（设计「测试策略」）
  - [x] 6.3 打包验证 `npx expo export --platform android`
  - [x] 6.4 文档同步