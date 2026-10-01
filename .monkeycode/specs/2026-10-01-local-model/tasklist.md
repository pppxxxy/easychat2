# 本地模型能力任务清单

## 方案与基础层

- [x] 确认 `llama.rn` v0.10+要求 New Architecture，当前 Expo SDK 54/RN 0.81 具备基础兼容方向
- [ ] 锁定具体稳定版本并在独立分支完成原生构建探针
- [x] 实现 `resourceMutex.js`
- [x] 实现 `modelManager.js`：下载、临时文件、版本、删除
- [x] 实现 `adapter.js`：可选 `llama.rn` 加载、初始化、推理、释放

## Provider 与 UI

- [x] 实现 `modelProvider.js`：在线/本地切换和一次性在线回退
- [x] 新增 `LocalModelPanel.js`
- [x] 设置页接入本地模型入口和状态
- [ ] 聊天设置接入在线/本地模式选择

## 验证

- [x] 补纯函数测试
- [ ] 存储失败注入测试
- [ ] Android prebuild/release 构建探针
- [ ] 运行 lint、test、coverage、expo export
- [ ] 真机验证下载、加载、取消、释放、回退和内存互斥
