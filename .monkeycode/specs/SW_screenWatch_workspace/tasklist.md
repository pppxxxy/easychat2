# SW：一起看屏幕·工作区版（任务书 SW1-SW4 落地记录）

> 依据：origin/main 6e093e0 的源码核验（screenWatch 全套 / WorkspaceScreen DOMAIN_PANELS /
> workspace agent 管线 tools.js + agentToolSetup）。用户额外要求：**悬浮窗内做 mini 聊天**
> （原任务书建议「不自嵌聊天 UI」，用户明确否决：要随手点开就下命令、说完收起）。
> SW4 来自真机反馈（挂死 / 连环闪退 / ANR），任务书 FIX-3 + FIX-4。

## 交付状态

| 期 | 内容 | 状态 |
|---|---|---|
| SW1 | 线程分 scope + 工作区左栏「看屏幕」面板 | ✅ 已完成（995798d6） |
| SW2 | 会话接工作区 agent 管线 + 命令确认 | ✅ 已完成（4fadadee） |
| SW3 | 悬浮窗 mini 聊天（原生） | ✅ 已完成（1e25e9f9 + d7c7292c 自查修 4 bug） |
| SW4 | 投屏 token 生命周期 + 采集管线线程化 + 打点 | ✅ 已完成（Kotlin 未编译，见下） |

## SW1：线程分类 + 左栏入口（纯 JS）

- `screenWatch/threads.js`：线程加 `scope`（'chat' 默认 | 'workspace'）。
  · `normalizeThreadScope`：非法/缺失 → 'chat'（旧数据无字段归聊天类，不丢线程）。
  · `getOrCreateActiveThread(characterId, name, now, scope)`：**续用判据同时匹配
    characterId 与 scope**——否则工作区看屏幕会接走聊天角色的线程（上下文串场）。
    签名向后兼容（旧调用点只传前三个参数，行为逐字不变）。
- `memory/memoryBuckets.js`：`groupScreenThreadsByScope` 纯函数（记忆界面按 scope 分组）。
- `workspace/screen/ScreenWatchPanel.js`（新）：左栏「看屏幕」领域面板——悬浮窗三态
  （支持性/权限/运行中）、开启关闭按钮、工作区线程列表。
- `WorkspaceScreen`：DOMAIN_KEYS 加 watch（放 history 与 settings 之间，同属「回看」性质）。
- 测试：`tests/screenWatchScope.test.mjs` 7 条（含续用隔离真行为测试 + 旧数据兼容）。

## SW2：接工作区 agent 管线（两条管线汇合）

**做法：复用既有 `headlessAgent.js`（工作区 agent 回合执行器），不另造一条。**

- `workspace/headlessAgent.js` 补三件事：
  · `confirm` 钩子（破坏性操作前确认；**不传 = 需要确认的工具被拒**，沿用 registry 纪律）；
  · `permissionRules` 透传（hooks.json + 用户存储合并入口——不接会让写工具上的手写
    deny 变成死键，P0-2 同款问题）；
  · `images` 多模态，走 `buildWorkspaceAgentMessages` 同一构造（避免两处格式漂移）。
- `screenWatch/workspaceWatchTurn.js`（新，纯逻辑 + 依赖注入）：回合编排——scope 分流、
  线程历史、本轮条目、失败文案。**不静态 import threads.js**（拉 expo 原生依赖，
  Node 测试进不来），role 字面量由测试与 threads.js 对齐。
- `ScreenWatchPanel`：加指令区（只读/可改模式 chips、输入、发送/停止、回复卡、
  「正在调用 X」）；确认走 `approveToolCall`，权限规则经 `storeRef` 读真实 store。
- 测试：`tests/workspaceWatchTurn.test.mjs` 13 条。

**自查修掉的真问题**：
1. `buildScreenWatchAgentHistory` 的 `limit=0` —— `slice(-0)` 等于 `slice(0)` 会返回
   **全部**历史（语义应是「不要历史」）；显式挡 0。
2. 权限规则最初漏接 → 写工具上的手写 deny 会变死键。
3. 面板最初用 `readHookPermissionRules(null, ...)` → 空 store 直接返回 `[]`（等于没规则）。

## SW3：悬浮窗 mini 聊天（原生）

**架构定死：原生只做嘴和眼**——LLM/工具/确认全在 JS 后台，原生只画结果。

- `OverlayService.kt`：展开态 = 标题行（含 scope 切换「工作区⇄聊天」）+ 消息区
  （ScrollView + 动态 TextView，上限 50 条）+ 输入行（EditText + 发送）。
- `ScreenOverlayModule.kt`：新增 `pushChatMessage` / `setImeInset`。
- JS：`overlayEvents` 加 `EVENT_CHAT_SEND` 与三个纯函数；`overlay.js` 加推送/inset/订阅
  （老构建安全降级）；`ScreenWatchScreen` 接监听按 scope 分流。
- 测试：`tests/screenOverlayChat.test.mjs` 11 条（纯逻辑 + Kotlin 静态契约）。

**悬浮窗场景的确认策略（如实收窄）**：不弹全屏 Alert（会盖住用户正在看的画面），
破坏性操作一律拒绝（`confirm: async () => false`）；想动手请到 App 面板（那里有确认卡）。

### ⚠️ 本机无法编译验证（重要）

本机**无 Android SDK / Java**（仓库 AGENTS.md 已记载该约束），Kotlin 改动只能靠
静态契约测试 + 人工审查兜底。逐行复查后修掉 4 个会在真机直接坏掉的 bug（d7c7292c）：

1. **`FLAG_ALT_FOCUSABLE_IM` 语义用反（最严重）**：它是**反转**语义——窗口可获焦点时
   置上它 = 宣告「不需要输入法」= **挡住 IME**。原写法「聚焦时置上」正好导致键盘弹不出来。
   改为聚焦时同时清掉 NOT_FOCUSABLE 与 ALT_FOCUSABLE_IM。
2. **`baseY` 用 0 当哨兵**：拖到顶部时 y 合法值就是 0，复位错位；拖拽后基准也不失效。
   改为可空 + 拖拽时清空。
3. **拖拽挂 rootView 抢走消息区滚动**：父级 OnTouchListener 先于子 View 拿到 touch。
   改为挂非滚动区（收起态挂球、展开态挂标题行）。
4. **收起态悬挂引用 + 消息丢失**：`showCollapsed` 摘除面板后没清引用，且消息随视图丢。
   补 `chatHistory` 留档 + 展开重画 + 收起清引用；删死字段 `panelContainer`。

### 真机验证清单（必须做，本环境做不了）

- [ ] 点输入框能否弹出键盘（部分 ROM 对 overlay 窗口输入法行为不一致；
      若某 ROM 仍不行，降级方案是「语音/快捷指令按钮 + 唤起 App 输入」）。
- [ ] 拖拽（标题行）与消息区滚动是否互不打架。
- [ ] scope 切换往返：切种类不清消息。
- [ ] 收起再展开：消息是否保留（chatHistory 重画）。
- [ ] 键盘弹起时面板是否上移（applyImeInset）、收起后是否复位。
- [ ] 工作区 scope：下一条只读命令（如「列一下文件」）能跑通。
- [ ] 聊天 scope：截屏问答仍正常。
- [ ] 后台约束：app 进程被杀 = 会话断（现状同款限制），文案需注明「加白名单/关电池优化可缓解」。

## SW4：投屏 token 生命周期 + 采集管线线程化（FIX-3 / FIX-4）

> 来源：真机反馈三个问题——①App 外截屏永停「正在看…」；②连环闪退；
> ③下命令卡死/闪退。复现序列：「扩展页开启 → 关掉 → 回设置页再点」。

### FIX-3：投屏授权 token 生命周期 + 双入口统一

**根因（三处咬合，全是实锤）**：

1. **token 只写不清**：`resultCode/resultData` 是**一次性**授权凭据，对应的 projection
   一 stop 就永久失效。旧代码里它只被写入、从不作废，于是「关掉再开」会带着失效 token
   启动服务。
2. **onCreate 无条件以 mediaProjection 类型 startForeground**：Android 14 要求该类型
   必须有**正在进行的有效授权**，旧 token 不满足 → `SecurityException`（第一次闪退）。
3. **`getMediaProjection` 无 try-catch**：失效 token 抛 `IllegalStateException`
   （第二次闪退，进程重启后的状态恢复路径再撞一次）。

**改法**：

- token 上移到 **companion object（进程级）**：只有进程级存储，`OverlayService.onDestroy`
  才够得着它；三个调用点统一清理——`stopOverlay`（用户关闭）/ `invalidate`（热重载）/
  服务 `onDestroy`（系统回收、锁屏、被抢占）。
- `setupProjection` 整段 try-catch：失效 → `clearCaptureToken()` + 回报
  `projection-invalid`，绝不裸崩。
- `startForegroundCompat`：**只在确实持有有效凭据时**才声明 mediaProjection 类型
  （从源头避开被拒）；仍保留 try-catch + 降级重试 + 最终 `stopSelf` 收口。
  诚实说明：不带类型时 Android 14 会回落用 manifest 声明的类型，所以降级大概率同样失败
  ——它的价值是**把异常关在闸里**（崩 → 明确失败），不是「救活采集」。
- **双入口统一**：新增 `ensurePermissionThenStart()`（overlay.js），
  悬浮窗权限 → 投屏授权 → 启动。`startOverlay` 在原生侧也内建了「无 token 先弹授权」，
  所以设置页直点不再必然失败（这正是「设置界面直接点显示失败」的设计缺口）。
- **幂等**：原生 `requestCapturePermissionInternal` 用回调队列排队复用同一次弹窗；
  JS 侧 `startChainInFlight` 复用进行中的链路。连点不会叠出两个系统授权框。

**自查修掉的 2 个真问题**（都是自己写的代码）：

1. `ensurePermissionThenStart` 最初把 in-flight 清理写在 async 函数体的 `finally` 里——
   同步提前返回的分支（无原生模块）会**先**把标记清成 null、随后赋值又把一个已结算的
   promise 钉上去，导致之后所有调用永远拿到旧结果、再也不真正启动。改为 `chain.then(clear)`。
2. 链路里最初调 `startOverlay()`（那个包装把一切异常吞成 `false`）——原生的真实失败会被
   误报成「投屏授权」档，界面把用户指去重新授权，而授权根本不是问题。改为直调原生并让
   异常穿透到 catch，才能区分「权限没给」与「启动真失败」。

### FIX-4：采集管线线程化 + 全程打点

**根因**：JPEG 压缩与全屏像素拷贝（`imageToBitmap` / `bitmapFromCachedFrame`）全在主线程
（1080×2400 一张几百毫秒起），而**所有失败兜底也挂在主线程 Handler 上**——主线程一堵，
截屏的全部失败路径（含超时回报）一起失灵，UI 永停「正在看…」。国产 ROM 冻结后台进程时
整个主线程暂停，表现完全一致。

**改法**：

- 新建单线程 `HandlerThread("capture-worker")`：解码、JPEG 压缩、写盘全移入。
  `onImageAvailable`（主线程）只做 `acquireLatestImage` + `copyPlane`（纯内存拷贝，
  微秒级，且**必须在 `image.close()` 之前**）+ 移交工作线程。
- **硬超时挂工作线程**（`CAPTURE_HARD_TIMEOUT_MS = 5s`）：主线程被冻结也能到点回报
  ——这是「一直等」的直接解药。到点 `emitCaptureFailed("timeout")`。
- `emitCaptureFailed` 统一**复位状态文字**（`setStatusText("")`），界面不再永停。
- **全程打点**：`recordTrace` 走 `EVENT_TRACE` → JS `addTraceListener` → 诊断日志
  （DiagnosticsModal 可见）。阶段：`capture-request` / `capture-saved`(带耗时) /
  `capture-failed`(带原因码) / `fgs-fallback` / `fgs-no-token` / `focus-on|off` /
  `ime-inset`。焦点与键盘也打点——问题③的 window 层级部分远程无法定死，靠现场数据。
- **原因码分档文案**：`captureFailureKey`（no-frame / timeout 各有专属文案）。笼统的
  「请重试」对「授权失效」与「系统冻结」都没用。
- **后台冻结引导**：`timeout` 且系统未放行后台运行时弹一次性引导
  （`isIgnoringBatteryOptimizations` + 跳电池优化设置）。

**自查修掉的真问题**：`bitmapFromCachedFrame` 一度**出现两次实现**（新写一份、旧的忘删）
——Kotlin 直接编译失败，而大括号平衡与全部 JS 测试都是绿的。据此在
`tests/helpers/kotlinStatic.mjs` 补了 `checkDuplicateFunctions`：沙箱没有编译器，
这类 redeclaration 必须由静态检查顶上。

### 测试

- `tests/screenOverlayLifecycle.test.mjs` 18 条：FIX-3 的 token 三处清理 / try-catch /
  前台服务降级与「只在有凭据时声明类型」/ 幂等 / 双入口统一；FIX-4 的线程化 / 硬超时挂
  worker / 失败复位 / 阶段打点齐全 / 打点事件名两侧一致 / 电池优化查询容错；
  以及大括号平衡 + **重复函数声明**（含检测器自检）。
- `tests/screenOverlayFailureKeys.test.mjs` 11 条：原因码→文案、启动失败档位、打点解析。
- `tests/screenOverlayStartChain.test.mjs` 9 条：真实 `overlay.js` + 打桩原生模块，
  覆盖权限顺序、并发只走一次、结束/失败后标记释放（钉住上面自查修掉的那个陷阱）、
  原生抛错如实归为 start-failed。

### 真机验证清单（本环境做不了，必须做）

- [ ] **原序列复现**：设置页直点（应弹授权 → 成功，不再「启动失败」）。
- [ ] 扩展页开启 → 关掉 → 回设置页再点（应重新弹授权，**不闪退**）。
- [ ] 进程完全重启后首次开启正常。
- [ ] **Android 14 真机必测**（SecurityException 只在 14+ 触发）。
- [ ] 荣耀真机：App 外静态画面（银行停留页）连截 3 次全通。
- [ ] 下命令（含截屏+识图）期间拖动悬浮窗不卡顿、其他区域可滑动。
- [ ] 连续下命令 5 次无 ANR 无闪退。
- [ ] 若仍偶发挂死：看诊断日志的 `capture-request`→`capture-saved` 断点，
      断在哪一环即锁定 ROM 冻结（走电池优化引导）。
- [ ] 键盘弹起/收起时小窗文字区是否复位（`ime-inset` 打点已埋好）。
- [ ] R6 的键盘/焦点用例全量回归。

## 明确不做

- 悬浮窗内不渲染 AS2 的完整题卡（原生只画是/否/其他三按钮的简化形态）；复杂确认回 App 面板。
- 悬浮窗场景不执行破坏性操作（见上「确认策略」）。
- FIX-4 未改 window 层级本身（问题③的「小窗以外滑不动」）：远程无法定死是哪一行，
  本批只做打点 + 回归，等真机日志。
