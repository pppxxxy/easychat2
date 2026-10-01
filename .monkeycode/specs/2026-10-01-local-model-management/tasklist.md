# 本地模型管理增强实施计划

- [x] 1. 重构数据模型与分键存储（需求 5/6）
  - 定义 `LocalModelItem`（id、量化、参数规模、来源/仓库路径、模型路径、mmproj 路径、能力标记、每模型 params、imported 标记）与 `LocalModelSettings`（enabled、activeModelId、apiServer）
  - 扩展 `src/localModel/modelState.js`：多模型规范化、旧单模型结构迁移、就绪判断改为按 `activeModelId`
  - 新增 `src/localModel/modelParams.js`：每模型参数默认值与校验（contextSize、gpuLayers、threads、temperature、topP、topK、maxTokens）
  - 新增 `src/storage/localModels.js`：`@easychat2_local_model_index` + `@easychat2_local_model_item::<id>` 分键读写，索引最后写入作为提交点，防单值超 2MB
  - `src/storage.js` 导出新 API，读失败时保留旧 `@easychat2_local_model` 走迁移
  - [x] 1.1 为 modelState/modelParams 编写单元与属性测试（非法输入回退、量化解析、参数边界）
  - [x] 1.2 编写分键存储失败注入与旧键迁移测试

- [x] 2. 检查点 - 确保所有测试通过，如有疑问请询问用户

- [x] 3. 模型搜索与目录（需求 1/3）
  - 新增 `src/localModel/modelCatalog.js`：HuggingFace 模型搜索 + 仓库文件树解析；**仅收录含 `.gguf` 的仓库**，结果只列出 `.gguf` 与配套 mmproj，非 GGUF 仓库一律过滤
  - 支持魔搭社区（ModelScope）搜索与文件解析，URL 规则 `modelscope.cn/models/<org>/<repo>/resolve/master/<file>`；同样仅收录 GGUF 仓库
  - 扩展 `LOCAL_MODEL_DOWNLOAD_SOURCES` 增加魔搭社区，每个源声明搜索适配与 URL 构建
  - 新增搜索选择弹窗：模型 ID 右侧搜索按钮触发，点击结果回填 id/名称/下载地址
  - [x] 3.1 为目录解析、GGUF 仓库过滤与 URL 构建编写单元/属性测试

- [x] 4. 量化与内存占用提示（需求 2）
  - 解析量化等级（Q2_K…Q8_0、F16 等）与参数规模（B 数）
  - 估算内存占用（权重 + KV cache + 运行时开销），读取设备可用内存（新增 `expo-device`）
  - 兼容分级：跑不了 / 难跑 / 特别合适推荐，面板展示量化 + 占用 + 推荐高亮
  - 移除「模型名称」自由输入，改为量化/占用/推荐展示
  - [x] 4.1 为量化解析、内存估算、分级编写单元/属性测试

- [x] 5. 下载与本地导入（需求 4）
  - 改造 `downloadLocalModel` 写入 `LocalModelItem` 并注册进索引
  - 新增导入：`expo-document-picker` 选择本地 `.gguf`，复制进 `documentDirectory/local-models` 并登记元数据
  - 导入时支持附带选择 mmproj 文件
  - [x] 5.1 编写下载/导入失败回滚与存储注入测试

- [x] 6. 多模型管理与参数 UI（需求 5/6）
  - `LocalModelPanel` 改为折叠模型列表：每项显示量化/占用/能力，可展开选择活动模型
  - 每模型「参数」按钮 + 参数面板弹窗，保存到该模型 params
  - 删除模型级联删除模型文件、mmproj 与参数（同一 item 键）
  - 资源互斥：一次只允许一个模型加载/推理，切换时先释放旧模型
  - [x] 6.1 编写选择、级联删除、参数隔离测试

- [x] 7. 检查点 - 确保所有测试通过，如有疑问请询问用户

- [x] 8. 推理适配增强与日志（需求 7/9）
  - `adapter.js` 改为 load/unload 常驻上下文，捕获加载与推理错误
  - 多模态：`initMultimodal(mmproj)`，打开图片/音频输入渠道（默认关，按能力启用）
  - 新增 `src/localModel/modelLogs.js` 内存环形日志（加载/对话/API），接入 `diagnostics.js`
  - 面板与聊天页新增「报错」入口查看日志
  - [x] 8.1 编写日志缓冲与错误分类测试

- [x] 9. 本地 API 服务（需求 8，完整原生实现）
  - 定义 apiServer 设置（开关、固定 host `127.0.0.1`、端口、apiKey）
  - 新增独立 Android 原生模块（Kotlin）实现 OpenAI 兼容 HTTP 服务：`/v1/chat/completions`、`/v1/models`，绑定 `127.0.0.1`，Bearer apikey 校验，复用已加载的 llama 上下文
  - 新增 `plugins/withLocalApiServer.js` 注入（MainApplication 注册、必要权限、服务生命周期），不手改 `android/`
  - 新增 `src/localModel/localApiServer.js`：原生桥接启停、状态查询与请求日志写入 modelLogs
  - 模型卸载/应用退后台时停止服务并释放端口
  - [x] 9.1 编写服务契约、启停与 apikey 校验测试
  - [x] 9.2 编写 Kotlin 源大括号平衡/顶层声明不重复回归测试（参照 `tests/proactiveMessagePlugin.test.mjs`）

- [x] 10. 聊天界面集成（需求 10）
  - `ModelPanelModal` 增加本地模型分组，每项旁加「加载/卸载」按钮
  - 加载状态、活动模型标识、加载失败提示与在线回退
  - 顶部三点「模型」入口直达本地模型列表
  - [x] 10.1 编写集成与回退测试

- [x] 11. 检查点 - 确保所有测试通过，如有疑问请询问用户

- [x] 12. 门禁验证
  - 运行 `npm run lint`、`npm test`、`npm run test:coverage`（通过：lint 零输出、727/727、覆盖率 83.47%）
  - `npx expo export --platform android` 通过（exit 0）；prebuild/Gradle release 校验新原生插件（`withLocalApiServer`）与 ABI 配置待 CI/本机（沙箱无 Java/Gradle）
  - [x] 12.1 同步 `SMOKE_TEST.md`、`.monkeycode/docs/`、`AGENTS.md` 存储键与原生插件说明

## 收尾补充（复核发现的接线缺口）

- [x] 9-补A 本地 API 服务运行时闭环：`App.js` 新增 `LocalApiServerBridge`（`attachLocalApiServerInference` 接常驻推理 + 资源互斥、退后台/卸载停服）；`LocalModelPanel` 增加 apiServer 开关/端口/apiKey 与启停、运行状态；`deactivateLocalModel` 与删除活动模型时停服。测试：`attachLocalApiServerInference` 可注入推理/回写（成功 + 失败路径）。
- [x] 8-补B 本地多模态输入渠道：新增 `filterRequestMedia` 纯函数 + `settings.enableMediaInput`（默认关）；ChatScreen 仅在开启且条目具备 `hasVision/hasAudio` 时把图片/音频发给本地推理，否则裁剪为纯文本；面板增加开关。测试：`chatPipeline.test.mjs` 裁剪切面、`localModel.test.mjs` 归一。
