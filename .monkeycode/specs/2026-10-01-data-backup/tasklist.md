# 数据导入导出任务清单

## 设计与纯函数

- [x] 实现 `src/dataBackup.js`：版本、脱敏、pending 过滤、导入计划、媒体路径校验
- [x] 增加 payload/plan/round-trip 单元测试

## 存储与媒体

- [x] 实现 `src/storage/backup.js`：大值读取、分键写回、媒体读写、失败统计
- [x] 接入现有 secretStore，确保密钥与安全存储引用不出包
- [ ] 增加存储失败注入和媒体恢复测试

## UI

- [x] 新增 `src/BackupPanel.js`
- [x] 设置 > 关于接入备份与恢复入口
- [x] 完成导出分享、导入选择、合并/覆盖确认与结果提示

## 验证与文档

- [x] 更新 `SMOKE_TEST.md`
- [x] 更新 `INTERFACES.md`
- [x] 运行 lint、test、coverage、expo export
- [ ] 完成真机换机/恢复走查
