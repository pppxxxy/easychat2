# 需求实施计划

- [x] 1. 默认开启
  - [x] 1.1 `DEFAULT_MEMORY_SUMMARY.enabled` 改为 `true`（需求 1.1）
  - [x] 1.2 `normalizeMemorySummary` 区分「从未保存」（默认开启）与「已保存 false」（保持关闭）（需求 1.2）
  - [x] 1.3 默认阈值沿用 40（需求 1.3）

- [x] 2. 检查点 - 确保所有可运行验证通过

- [x] 3. 阈值保存修复
  - [x] 3.1 `PresetPanel.commitThreshold` 先记录旧值再写输入框，按旧值判断是否写入（需求 2.1、2.3）
  - [x] 3.2 非法值提示并回退默认（需求 2.2）
  - [x] 3.3 保存失败提示并保持（需求 2.4）

- [x] 4. 检查点 - 确保所有可运行验证通过

- [x] 5. 回归与文档
  - [x] 5.1 脚本验证：默认值、已保存 false 保持、非法 threshold 回退
  - [x] 5.2 打包验证 `npx expo export --platform android`
  - [x] 5.3 文档同步