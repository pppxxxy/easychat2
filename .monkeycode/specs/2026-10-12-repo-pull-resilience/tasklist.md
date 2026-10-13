# R 系：GitHub 拉取健壮性与残缺态修复 — tasklist

spec: 2026-10-12-repo-pull-resilience ｜ 依据 main（ed4a2b5）源码核验
用户实测：自家仓库（工作树 9.7MB / 1059 文件）往往拉取失败且残缺过一次；
对照仓库手动重试几次可成。截图对账：待同步 新增 5 · 删除 420 = 弹窗 425 处。

## 现状基线（已核验，勿重做）
- restApi.js：downloadZip retries=1、ZIP_TIMEOUT_MS=90s（注释假设 6MB，实际 9.7MB+1059 文件）；
  codeload 实测不回 content-length（chunked），预检形同虚设。
- history.js：beginBatch 仅聚合历史记录，abortBatch 不回滚文件（非事务，客观接受，R1 兜底）。
- useRepoPull.js：B3 覆盖守卫与 F4 manifest 残留检测互不联动。
- repoDiff.js：pending = added + removed 合并计数；removed 大 = 残缺嫌疑，原先不可区分。
- 推送面板「待同步」与 B3 共用同一 diff——残缺态下把缺口当「待删除推送」，误删远端风险。

## 任务清单

### R0 传输预算 —— 已完成
- [x] R0-1 downloadZip retries 1 → 3（ZIP_RETRIES），退避复用 GITHUB_RETRY_DELAYS（1s/2s/4s，
      末次钳到表尾）。断流、body 停滞、可重试 HTTP 错误三类共用预算。
- [x] R0-2 超时分级：ZIP_TIMEOUT_MS 90s → 240s；zipTimeoutFor(contentLength) 纯函数——有
      content-length 按 64KB/s 估算，夹在 [240s, 600s]（ZIP_TIMEOUT_CAP_MS），无（codeload 现状）
      按 240s 兜底。补 body 读取阶段停滞掐表（RN fetch 响应头即 resolve，chunked 停滞原会挂死）。
      注释删「6MB 级」过时假设，标注实测 9.7MB/1059 文件与 chunked 无 length。
- [x] R0-3 前台保活：拉取全程 expo-keep-awake activateKeepAwakeAsync/deactivateKeepAwake
      （tag=easychat2-repo-pull；activate 失败静默、finally 只对成功 activate 的解除）。
      expo-keep-awake ~15.0.8 提升为直接依赖（原为传递依赖，package.json + lock 已同步）。
- [x] R0-4 失败文案细分：新纯模块 github/errorCopy.js（describeGithubError，注入 t，Node 直测）——
      NETWORK（已自动重试 {retries} 次 + 整包重下语义）/ RATE_LIMIT（Retry-After 折算「约 N 秒后可重试」）/
      REPO_LIMIT_* 与 REPO_EMPTY（缩小范围 / 快速检出建议）。GithubPanel.describeError 改走它；
      旧 ERROR_KEYS 表并入 errorCopy.GITHUB_ERROR_KEYS。
- [x] downloadZip 契约改 { declared, bytes }：body 归传输层读完（停滞可控、重试语义清晰）；
      content-length 预检收进 maxBytes 参数（useRepoPull 传 REPO_IMPORT_LIMITS.MAX_DOWNLOAD_BYTES），
      真实字节仍由 scanRepoZipball 复核。

### R1 残缺态识别与守卫联动 —— 已完成
- [x] R1-1 pullSnapshot 入口统一裁决序（纯函数 repoDiff.classifyPullGuard + pullGuardCopy，可 Node 直测）：
      (a) readPullManifest 有残留 → dirtyPull：**跳过 B3 覆盖守卫**，弹说明框「上次拉取未完成，
          缺 {missing} 个文件（上次目标 {target}）；本次重新拉取将修复缺失文件」，按钮 取消/重新拉取；
      (b) 无残留 && pending>0 → B3 守卫，文案拆双数字（新增 {added}、缺失 {removed}），
          removed>added 时附残缺嫌疑提示（overwriteBodySuspect）；
      (c) 本地为空或无增删 → 放行。旧合并计数词条 overwriteBody 已删（zh/en）。
- [x] R1-2 diffRepoSnapshot 纯函数签名不动（added/removed 早有），只改消费方。
- [x] R1-3 推送面板防误删（最高优先级）：isDirtyPullState（**只认硬信号 = manifest 残留**；
      「缺失远多于新增」拆成独立软信号 hasMissingGaps——只提示不阻断，因为「用户真删了 20 个文件
      再推送」是合法操作，阻断会死锁；批量推送确认门已有异常放大二次确认兜底）。useRepoPull 暴露
      pullManifest（挂载读 / 拉取进入时读 / 写入窗口置态 / 成功清空）；GithubPanel 据此 dirtyNote
      提示 + 推送/标记已同步/交接按钮置灰（软信号显示 gapsNote）；useRepoPush 内部 pushBatch/
      markSynced 同款**结构性阻断**（不靠 UI 自觉，与仓库「守卫做成结构性」纪律一致）。
      顺带修正 pull.cancelled 假文案（beginBatch 非事务，取消并不回滚已写文件——旧文案说「已回滚」）。
- [x] R1-4 拉取成功路径（clearPullManifest + setRepoSnapshot + written/skipped 记录）不变。
- [x] R1-5 Node 直测：classifyPullGuard 三态含 425/420 截图对账、pullGuardCopy 键与参数、
      isDirtyPullState 硬信号口径、hasMissingGaps 阈值边界（9/10/新增更多）、
      文案占位符 zh/en 联动（translate 渲染无残留 {）、
      守卫先于下载 + manifest 先读后裁决的接线回归（repoImport/workspacePanel 两处旧断言同步改造）。
- [x] R1-6 **复查补修（同一失败类的第二个入口）**：`useRepoBranch.quickCheckout` 原把 Trees 清单
      **全量**写进基线（`entries.filter(item => item.type !== 'tree').map(...)`）。基线在
      `repoPush.diffRemoteLocal` 里的语义是「**曾经物化过**」的证据——全量基线让每个未物化的
      远程文件满足 `remote ∧ known ∧ ¬local`，被判成「用户删除」：**快速检出后直接点推送 =
      用 sha:null 条目删掉整仓远端文件**（本地实测：3 文件仓库 remote=[a,b,c]、本地只物化 a、
      基线=全树 → `removed=[b,c]`）；面板「待同步」同时也把未物化文件报成「删除 N」——与截图
      同一类误导。修正：基线只写本地已物化清单（`localRepoPaths`，与完整拉取/推送成功路径同口径），
      未物化文件退回 G1 的 `remoteOnly` 第三态（保持原样、点名、不进 pending）。纯函数契约
      `repoPush.test.mjs`「全量未物化 → 删除恒空」原本就写明了正确语义，接线与它相悖——本次把接线
      对齐契约，并把反例（全树基线 → removed 非空）钉成行为测试；AGENTS.md 不变量增 ⑦。
      残留小口径（如实记录、不阻断）：快速检出后按需物化的文件在「待同步」里会被算成「本地新增」
      （路径 diff 判定不了「它只是远程副本」）；推送门按 blob sha 复核 → 结果仍是「无待推送」，
      不会误推。点「标记为已同步」或跑一次完整拉取即回到精确口径。

### R2 按文件拉取管线 —— 评估先行（一页结论如下，未排实现）
结论：**建议暂缓实现，zip 路线在 R0+R1 后覆盖当前已知痛点；待真实弱网失败样本再立项。**
理由（vs zip 现状）：
- 请求量：1059 文件 ≈ 1 次 trees + ≥1059 次 contents。认证用户主限流 5000 req/h 够用，但
  secondary rate limit（并发/突发）对「~1000 个小请求」敏感——必须并发池 ≤4 + 退避纪律 + 抖动
  （repoPush.mapLimit 基建可复用），整包耗时下限仍受 RTT×请求数支配：手机网络 RTT 50–300ms 时
  1059/4 × 150ms ≈ 40s–2.5min **纯请求时间**，zip 单连接同档体积通常 10–60s 内完成——多数场景反而更慢。
- 断点价值：manifest 记已写文件后重拉只补缺口，这是 zip 给不了的；但 R0-3 保活 + R0-1 重试预算 +
  R1 守卫联动已把「残缺」的用户可感知面（误报弹窗、误删推送）治掉，残缺本身的发生率主要取决于
  进程存活，不取决于传输形态。
- 结构弱点仍在：>1MB 文件 contents 不内联（encoding=none 需 blobs 接口二次跳转）；二进制仍要跳过；
  内存恒定是优点，但 zip 路线 200MB 上限对「文本工作副本」场景够用。
- 触发重估的条件：用户仓库文本外二进制资源变多（assets/）导致 zip 总量逼近上限；或实测出现
  「R0 预算内多次整包重下仍失败」的样本（届时断点续传是刚需）。
- 若立项：trees 递归清单 → 并发池(4) contents（复用 C4 request 基建）→ .easychat/pull-manifest
  扩展记「已写路径」→ 重拉按清单跳过已写；zip 保留为小仓库快路径。预估 2–3 天 + 限流纪律测试。

## 顺序与门禁 —— 已完成
- [x] R0 → R1 同批（本分支 m1012m31 随本提交并入 main）。
- [x] lint（0 输出）/ guard:structure（ok，棘轮协议②：GithubPanel 911→919 同提交记录理由）/
      npm test（3697 全绿）全过。
- [x] 纯函数 Node 直测先行：zipTimeoutFor / classifyPullGuard / pullGuardCopy /
      isDirtyPullState / describeGithubError（注入 t）。
- [x] spec 落 .monkeycode/specs/2026-10-12-repo-pull-resilience/tasklist.md（本文件）。
- [x] AGENTS.md 增补纪律：beginBatch 非事务——任何依赖回滚语义的新功能必须自带清单式清理；
      拉取守卫必须先查 manifest 残留。

## 明确不做
- git clone 路线（Android 无 git 二进制，客观死路——repoImport.js 头部注释）。
- zip Range 断点续传（codeload 不支持，实测 chunked）。
- 事务式批量写（store 层重构大动干戈，R1 的 manifest 兜底已覆盖用户可感知面）。

---

# R3-R5 续档（2026-10-12，审核报告 Q1/Q3/Q4 的落地）

> 复核口径：审核报告基于 ed4a2b5，其中「没接 KeepAwake」一条**在 d6110066 已修**（R0-3）；
> 其余三条在实现前都用真代码/真函数复验过，结论与报告一致处照做、不一致处以实测为准。

## R3 TurnSummaryPanel 大列表（Q1「卡死不能滑」）—— 已完成
- [x] 根因复验：`TurnSummaryPanel` 原 `files.map()` 裸渲染全部条目，面板**没有滚动容器**；
      ChatPanel 的列布局是「消息 ScrollView（1562 行）→ SessionSidePanels（1604 行，在
      ScrollView **外面**）→ 输入区」——整仓提交（1066 文件 ≈ 2.1 万像素）把消息区挤到 0 高，
      面板自己也不滚动，两头都动不了。
- [x] 修法：新纯模块 `screen/turnSummaryFiles.js`（`summarizeTurnFiles`）决定「内联多少 / 折叠多少」：
      ≤40 全内联；41..100 内联 40 + 「还有 N 个（查看全部）」；>100（批量提交）内联 **0** 条、只报总数。
      内联明细再套 `ScrollView maxHeight:240` + `nestedScrollEnabled`（双保险：条数与像素都不设界才叫 bug）。
- [x] 完整清单走底部 `Sheet` + `FlatList`（虚拟化，1066 条只渲染视口内的行）。
- [x] Node 直测：5 条边界（5 / 40 / 41 / 100 / 1066 / 坏输入，含「阈值是超过而非等于」）+
      zh/en 词条与占位符渲染（translate 无残留 `{`）。

## R4 拉取所有权上提（Q3「切标签中断」）—— 已完成（诊断结论 + 迁移）
- [x] **诊断结论（修正报告的一处推断）**：切标签**不会**杀死写入循环——循环活在组件闭包里、
      store 是屏幕级的、卸载只翻 `mountedRef`（`GithubPanel` 卸载不碰取消标志）。用户看到的是
      **失明**：进度/忙碌态是 hook 局部 state，重挂载即归零 → 界面显示「没在拉取」；切回来时
      列表只有已写完的部分 → 观感是「断了」。**但报告指出的第二个风险是真的**：重入守卫
      `if (pullBusy) return` 同样是局部 state，重挂载后可以再点一次 → 两个写入循环并发写同一 store。
- [x] 修法：新模块 `screen/github/pullController.js`（模块级单例，零 RN 依赖）：面板只订阅
      （`useSyncExternalStore`），`running/progress/notice/eta/cancelRequested` 都不再随卸载蒸发；
      二次点击由单例拒绝并弹「已经在拉取中」；取消按钮改走 `requestPullCancel()`。
- [x] 失明可恢复：控制器记 `lastResult`（起止/耗时/写入数/完成时面板在不在场），面板不在场时完成
      会置 `finishedWhileAway`，重挂载后如实提示「上次拉取已在你离开时跑完（写入 N 个）」——
      这正是报告要做 pull-log 的那个诊断问题，用**用户可见的界面事实**回答，且不新增 `.easychat/*.json`
      （隐藏清单只收目录前缀，新增顶层 json 会污染文件树视图）。
- [x] KeepAwake 保持（R0-3 已有）；锁屏仍是唯一真中断源。
- [x] Node 直测：6 条（双写拒绝且不清正在跑的进度、卸载重挂载仍读得到进度/提示、订阅退订与
      订阅者异常不外抛、取消只在运行中置位且收尾清位、在场/不在场两种收尾、挂载计数成对不落负）。
- [ ] 设备复测（需要真机，本环境无法执行）：切标签 → 切回，应看到「仍在拉取（进度 x/y）」或
      「已在你离开时跑完」二者之一；报告里「等很久文件数也不涨」的场景若仍复现，才说明是**真死**
      （届时看 `lastResult.result` 与耗时，而不是靠猜）。

## R5 写入提速（Q4「慢」）—— 部分完成：R5-1 已落地，R5-2/R5-3 评估后推迟
- [x] **R5-1 目录 URI 缓存（最大单点收益，已做）**：`safStore` 加 `segments → uri` 缓存，
      **只服务写路径**。为什么不给读路径：`listChildren` 对失败是「当空目录」，死链缓存会让
      列表/读取**静默变空**——那比慢严重得多；写路径失败是显式抛错，可自愈（失效重建重试一次）。
      失效点：`deleteWorkspaceDirectory`（含子孙）、`moveWorkspaceDirectory`（源与目标）、
      以及任何写失败后的自愈。
      实测（假 adapter 计 IPC，9 段路径 × 200 文件）：**listChildren 208 次 vs 未缓存约 2010 次 ≈ 10x**，
      即每文件从「9 段下降 + 1 次查文件」降到「1 次查文件」。
- [x] Node 直测：收益断言（每文件只多 ~1 次 IPC）+ 内容正确性 + 读路径不吃缓存（外部删目录后
      列表如实变空）+ 缓存被外部删除后**自愈** + 删除目录后失效（同名重建能写）+ 沙盒间不串 uri。
- [ ] **R5-2 写入并发池（4-8）：推迟，理由如下。** 报告自己也点了「同目录并发创建的竞态」——
      按父目录串行、跨目录并行的实现要引入分组调度器；而 SAF 的 `createFile/createDirectory`
      在 Android 各厂商实现下的并发语义**无法在本环境验证**（没有真机/模拟器），猜错的代价是
      重复建目录或写坏文件。R5-1 已把每文件 IPC 从 ~12 降到 ~2，先让真机数据说话：
      等 R4 的 `lastResult`（已完成时/写入数/耗时）拿到真机「写入阶段耗时」再决定是否值得冒这个险。
- [ ] **R5-3 重拉哈希跳过：推迟，理由如下。** 它要求 manifest 从「记文件数」升级为
      「记 path+hash + 每 25 文件增量落盘」，也就是**改动 R1 残缺态判定的输入格式**（v1 → v2，
      还要写迁移与旧值兼容）；同时它把「partial manifest = 上次没跑完」的语义扩成「断点续传」，
      与 R1 的守卫裁决序、`clearPullManifest` 时机、取消语义都要重新对齐。收益确实大（弱网重拉），
      但它是**功能改造而非提速补丁**，值得单独一批：先出 v2 schema + 迁移 + 断点续传的验收口径
      （含「哈希相同但内容被外部改过」的边界），批准后再实现。本批已为其铺好地基：manifest 写入
      点集中在 `useRepoPull`，判定集中在 `repoImport` 的纯函数。

## 顺序与门禁（本批）—— 已完成
- [x] R3 独立先行（纯函数 + 面板有界化）；R4 控制器与迁移；R5-1 缓存。每步 lint / guard:structure /
      npm test 全绿；spec 状态与裁决记在本文件。
- [x] 明确不做（沿用报告）：unzipSync 异步化（1-3s 可忍）、下载多路分片（codeload 无 Range）、
      拉取期间禁止切标签（治标不治本——正确形态是失明可恢复，已按此实现）。

## R6 Sheet 内滚动列表被 dismiss 背景锁死（2026-10-13，R3 自己引入的回归）—— 已完成
- [x] 复现与根因核验（origin/main 6e093e0）：Sheet 'dismiss' 模式的背景 Pressable 是卡片
      （及其中 FlatList）的祖先；Android 上 Pressable 认领 responder 且拒绝让渡 → 列表滚不动、
      轻点误关（更深层的 TouchableOpacity 能赢手势，所以「点击正常、拖动全灭」）。
- [x] 修法取任务书的方案 2（一步到位，非 static 救急）：sheetLayout.js 新增纯函数
      `resolveSheetDismissArea`（只有 dismiss 语义才谈得上 above）；Sheet 新增
      `dismissArea="above"`——View(flex:1) 纵排 [上方空白条 Pressable(onClose), 卡片]，
      卡片不再是 dismiss 背景的后代；点上方空白仍可关闭。默认 'wrap' 路径逐字节不变
      （16 个既有居中弹窗零影响，chatA11y/chatExportUi 回归全绿）。
- [x] TurnSummaryPanel 的「全部文件」Sheet 改用 `dismissArea="above"` +
      FlatList `keyboardShouldPersistTaps="handled"`。
- [x] 防复发：Sheet.js 头部注释写明结构纪律（滚动列表不得为 dismiss 背景 Pressable 的后代）；
      uiSheet.test.mjs 钉纯函数全取值 + above 分支结构 + 卡片单一构造点（两条路径共用，
      模态标记不因分支漏配）+ 接线判据。
- [x] 真机验证（待办，本环境无设备）：开「全部文件」上下滑动应顺畅、点列表区不误关、
      点卡片上方空白关闭、× 关闭正常。
- [ ] Q2（拉取跳过 20 个二进制）：裁决**不改**——纯文本沙盒设计使然，全部是应用图标/引导图，
      无损（远端完好、永不进推送面）、云构建兜底；为 20 张图扩二进制写安全面是负收益。
