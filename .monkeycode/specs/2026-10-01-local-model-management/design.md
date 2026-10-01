# 本地模型管理增强 — 技术设计（任务 8–12）

Feature Name: local-model-management
Updated: 2026-10-01

本文件承接 `tasklist.md`，补齐任务 1–7 已实现之外的剩余设计（推理适配、本地 API 服务、聊天集成、门禁）。

## 任务 8：推理适配增强与日志（需求 7/9）

### 常驻上下文
`src/localModel/adapter.js` 从「每次请求 init/release」改为**进程内常驻**：

- 模块级 `current = { key, context, support } | null`；`key` = `modelPath|n_ctx|n_gpu_layers|mmprojPath`。
- `loadLocalModel(model)`：key 命中直接复用；否则先 `unloadLocalModel()` 再 `initLlama`；若 `mmprojPath` 存在则 `context.initMultimodal({ path })` 并读 `getMultimodalSupport()`。
- `unloadLocalModel()`：`releaseMultimodal()` + `release()`，清空 `current`；模块不可用时清空即可。
- `runLocalModel(messages, model, { onToken, signal, params })`：确保已加载 → `context.completion(params, cb)`；`signal` abort 时调用 `context.stopCompletion()`。
- 参数：把 `model.params`（`modelParams.js`）映射到 llama.rn 的 `n_ctx/n_gpu_layers/n_threads/temperature/top_p/top_k/n_predict`。
- 出错抛出带 `code` 的错误，交由 `modelProvider` 分类。

### 多模态
- 默认关闭图片/音频输入渠道；仅当模型条目 `hasVision/hasAudio` 且有 `mmprojPath` 时才 `initMultimodal`。
- 请求消息里的 `content` 数组（image_url / input_audio）由 ChatScreen 组装，adapter 原样透传。

### 日志
- 新增 `src/localModel/modelLogs.js`（**纯函数 + 内存环形缓冲**，不依赖 RN）：
  - `recordModelLog(event, message, { level, context, at })`，`MAX_MODEL_LOGS = 200`，`level ∈ info|warn|error`。
  - `getModelLogs()` / `clearModelLogs()` / `formatModelLogs(list)` / `__resetModelLogsForTests()`。
  - `classifyLocalModelError(error)`：把错误映射为 `{ code, level, message }`（`LOCAL_MODEL_UNAVAILABLE` / `RESOURCE_BUSY` / `AbortError` / `LOAD_FAILED` / `INFERENCE_FAILED`）。
- `adapter.js` 在 load/unload/chat/api 记录日志；错误级同时 `recordDiagnostic('api', error, 'local-model')`。
- 新增 `src/localModel/ModelLogsModal.js`（UI，登记进 `.c8rc.json` 排除）：展示/清空日志；设置页 `LocalModelPanel` 加「日志」入口。聊天页入口在任务 10。

## 任务 9：本地 API 服务（需求 8）

### 架构决策（重要）
Kotlin 独立模块**无法直接复用 JS/JSI 侧已加载的 llama 上下文**。采用「原生 HTTP 服务 + JS 推理桥」：

```
OpenAI 客户端 -> 127.0.0.1:port (Kotlin ServerSocket/NanoHTTPD)
   -> emit LocalApiServer:onRequest { requestId, path, body }
   -> JS 监听：用常驻 adapter 推理 -> native.respond(requestId, json)
   -> Kotlin 写回 HTTP 响应
```

- 支持 `POST /v1/chat/completions` 与 `GET /v1/models`；`Bearer` apikey 校验（未配置空 key 时放行）。
- 绑定 `127.0.0.1`，用户仅可改端口与 key。
- 流式：`stream:true` 时先回一段 SSE `data: {...}` 再 `data: [DONE]`（v1 不做逐 token 分片），`stream:false` 回标准 JSON。
- 模型卸载 / 应用退后台（`onHostPause`/`onCatalystInstanceDestroy`）时停止服务、释放端口。

### 原生与插件
- `plugins/localApiServer/android/LocalApiServerModule.kt` + `LocalApiServerPackage.kt`（包 `com.pppxxxy.easychat2.localapi`）。
- Gradle 依赖 `org.nanohttpd:nanohttpd:2.3.1`（插件幂等注入）。
- `plugins/withLocalApiServer.js`：copy 源码、注册 MainApplication（沿用 `withProactiveMessage` 的 SDK50/54 双模板补丁与守卫）、Gradle 依赖、`INTERNET` 权限（幂等）。
- `app.json` plugins 追加 `./plugins/withLocalApiServer`。
- JS 桥 `src/localModel/localApiServer.js`：`isLocalApiServerAvailable`、`start(settings)`、`stop()`、`getStatus()`、`addRequestListener(cb)`；监听后调用 adapter 推理并 `respond`。

### 测试
- `tests/localApiServerPlugin.test.mjs`：Manifest 权限/组件、Gradle 幂等、MainApplication 双模板、Kotlin 大括号平衡 + 顶层声明不重复（参照 `tests/proactiveMessagePlugin.test.mjs`）。
- `tests/localApiServer.test.mjs`：JS 桥契约（可用性、路径/模型响应构造、Bearer 校验、请求→推理→respond 的纯逻辑抽取）。

## 任务 10：聊天界面集成（需求 10）

- `ModelPanelModal` 增加「本地模型」分组：列出索引条目，每项旁「加载/卸载」按钮；本组不含在线来源切换逻辑。
- `useChatModelThinking` 扩展：读取 `getLocalModelIndex`/`getActiveLocalModel`，暴露 `localModels`、`activeLocalModelId`、`activateLocalModel`、`unloadLocalModel`。
- 加载状态、活动模型标识、加载失败提示；失败时 `modelProvider` 自动回退在线一次。
- 聊天页「更多 → 模型」入口同时可达在线与本地；`ChatTopBar` 保持现状。
- `MoreMenuModal` 增加「本地模型日志」（任务 8 的 modal）。
- 测试：`tests/chatLocalModel.test.mjs` 覆盖选择/回退纯逻辑（从 hook 抽出的纯函数）。

## 任务 12：门禁与文档

- `npm run lint` / `npm test` / `npm run test:coverage`；`npx expo export --platform android`（沙箱内存紧时在 CI 验证）。
- 同步 `SMOKE_TEST.md`（本地模型多模型/导入/日志/本地 API 服务走查项）、`.monkeycode/docs/INTERFACES.md` 与 `AGENTS.md`（存储键、原生插件、服务契约）。

## 风险

- Kotlin 无法在沙箱编译（无 Java/Gradle），只能靠结构回归测试兜底；`nanohttpd` 需联网拉依赖，CI 编译验证。
- 常驻上下文内存占用高：切换模型、退后台、删除活动模型时务必 `unloadLocalModel()`。
- 新架构 Interop：HTTP 请求回调尽量用 JSON 字符串契约，避免数组编组（沿用主动消息的教训）。

## 补充 A：本地 API 服务运行时闭环（任务 9 收尾）

现状：Kotlin 模块 + 插件 + JS 桥 + 结构测试已就绪，但**应用运行时从未启动/接线**。补齐：

- `App.js` 新增 `LocalApiServerBridge` 组件（挂在 `ProactiveMessageBridge` 旁）：
  - 挂载时若 `isLocalApiServerAvailable()`，用 `attachLocalApiServerInference({ runInference })` 接上常驻推理：`runInference` 动态取 `getActiveLocalModel()` → `tryAcquireResource('local-model')` → `runLocalModel(messages, item)` → 释放锁；返回文本。
  - `AppState` 从 active 变为后台时 `stopLocalApiServer()`（释放端口）；卸载时同样停服。
- `src/LocalModelPanel.js` 新增「本地 API 服务」区：开关、端口、apiKey（写入 `settings.apiServer`）+ 启动/停止按钮 + 运行状态；启动前保存配置，`modelId` 用 `activeModelId`。
- 停服时机：`useChatModelThinking.deactivateLocalModel`、删除活动模型、`LocalApiServerBridge` 退后台/卸载。
- 测试：JS 桥纯函数与降级路径已有覆盖；新增 `attachLocalApiServerInference` 的可注入推理/回写测试（用可注入的 listener/respond 桩）。

## 补充 B：本地多模态输入渠道（任务 8 收尾）

现状：adapter 已 `initMultimodal`，但本地推理路径默认会把 `buildRequestMessages` 产出的 `image_url`/`input_audio` 一起发出去，未按能力/开关裁剪。补齐：

- `src/localModel/modelState.js`：`DEFAULT_LOCAL_MODEL_SETTINGS` 增加 `enableMediaInput: false`（默认关），`normalizeLocalModelSettings` 归一。
- `src/chatPipeline.js`：新增纯函数 `filterRequestMedia(messages, { allowVision, allowAudio })`：
  - 数组 content 中只保留 `text` 与允许的 `image_url`/`input_audio`；裁剪后若无媒体则折叠成字符串 content；空消息丢弃。
  - 字符串 content 原样返回。
- `src/ChatScreen.js`：本地就绪时（`canUseLocalModel`）把 `requestMessages` 经 `filterRequestMedia` 处理后再交给本地推理；`allowVision = enableMediaInput && item.hasVision`，`allowAudio = enableMediaInput && item.hasAudio`。在线路径不变。
- `src/LocalModelPanel.js`：新增「允许图片/音频输入（需模型支持）」开关，保存 `settings.enableMediaInput`。
- 测试：`tests/chatPipeline.test.mjs` 覆盖裁剪/折叠/丢弃；`tests/localModel.test.mjs` 覆盖 `enableMediaInput` 归一。
