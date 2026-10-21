# 真机日志修复（vector 引用契约 + 调度埋点）spec 2026-10-21-log-fixes

> 输入：用户提供的 2026-10-20 ~ 10-21 诊断日志。逐条分流后只有两条是真问题；
> 分支 `c1021c3`；全量 4764 通过（+2，另修 4 条既有测试的错误假设）。

## 日志分流

| 日志 | 判定 | 处理 |
|---|---|---|
| `[perf] app.tick 18493ms > 800ms` | **埋点口径错误**：把「定时任务真的跑完一轮」（模型+工具，十几秒正常）算成了调度器卡顿 | 拆开计量：`app.tick` 只量「选任务」，执行改 `agent.task.run` + 120s 宽松阈值 |
| `向量索引返回了新引用但内容未变`（context `mcp-test-10210728`） | **真问题**：删除类 updater 在「一个都没命中」时仍返回新数组（空索引场景尤其常见），触发护栏诊断并白写整索引 | `removeVectorIndexForMessages` / `removeVectorIndexForSessions` / 溯源面板 `dropMemories` 全部改为「无变化返回 current」 |
| `[screen-overlay] overlay-config saved` 多次 | 正常：JS 在保存 API 配置/切模型/切角色/打开看屏幕页时主动写入，日志频率随用户操作 | 不改 |
| `app.refreshSessions 132~150ms > 120ms`、`session.loadMessages 124ms > 120ms` | 轻微、冷读；阈值 120ms 是「明显迟滞」界，未构成故障 | 记录观察，不改（避免为 4~30ms 引入缓存复杂度） |

## 修复 1：向量索引引用契约（真机错误）

契约（`storage/vector.js` 的 updateVectorIndex）：updater 没改内容时必须**原样返回
`current` 引用**；返回新引用会让整条索引重新 normalize + stringify + 写盘
（1000 条 × 1024 维 ≈ 19.8MB）。

三处违反：

1. `removeVectorIndexForMessages`：`current.filter(...).flatMap(...)` 无条件造新数组，
   一个都没删掉也一样。改为逐条判定：命中→整条删；未命中→仍调用
   `pruneMergedSources`（合并记忆 messageId 为 ''，但 mergedFrom 可能引用被删消息，
   P1-6b 语义必须保留），只有真的删了/剪了才 `changed = true`。
2. `removeVectorIndexForSessions`：`filter` 同样无条件造新数组。改为无变化时返回
   `current`；`pruneSources: true` 路径**不能**因「整条没删」就提前返回——合并快照
   仍可能引用被删会话，必须逐条 prune（第一版就踩了这个坑，既有 P1-6b 测试抓住）。
3. `MemoryProvenanceModal.dropMemories`：`filter` 同病，改为无变化返回 current。

## 修复 2：调度埋点（日志误导）

`agentTaskScheduler` 原先把 `runDueAgentTasks`（选择 + 串行执行任务）整体包进
`measureAsync('app.tick', ..., 800ms)`。任务一跑十几秒就报「调度器卡了 18 秒」，
真正需要定位的主线程卡顿反而被淹没。

拆分为两段（`agent/task/taskDispatch.js`）：

- `collectDueAgentTasks({ deps, now })`：读任务表 + `collectDueTasks` 纯筛选，
  返回 `{ deps, due }`——调度器只把这一段包进 `app.tick`；
- `executeDueAgentTasks(due, deps, { now, notify, measureTask })`：串行执行，
  `measureTask(task, run)` 让调度器给每个任务单独计时；
- `runDueAgentTasks` 保留为组合入口（后台 headless 等调用方零改动）。

调度器：`app.tick` 量 collect（阈值 800ms）；每个任务 `agent.task.run`
（阈值 120000ms，只有异常卡死才留诊断）。任务的 `now` 只取一次，选择与执行同一天。

## 测试

- `tests/vectorReferenceContract.test.mjs` 新增：未命中的按消息/按会话删除
  **不写盘、不报契约诊断**；真命中仍写盘。
- `tests/agentTask.test.mjs` 新增：collect 只选择不执行；execute 串行 + 独立计时；
  读取失败返回空 due。
- `tests/perfProbeWiring.test.mjs` 更新：mock taskDispatch 提供 collect/execute；
  断言 `app.tick` 只包 collect、`agent.task.run` 每任务一条 + 120s 阈值。
- `tests/vectorMemory.test.mjs`：源码断言改为容忍「无变化返回 current」的新早退形态
  （语义不变：默认分支不碰 mergedFrom 快照）。

## 验证

全量 4764/4764；lint 0；guard ok；i18n 0 缺失。

## 真机复测

1. 打开向量记忆、进入一个还没有任何向量分段的新会话 → 切分支/重生成/删除消息
   → 诊断日志不再出现「向量索引返回了新引用但内容未变」；
2. 定时任务到点后看诊断：不再出现 `app.tick > 800ms`，只有
   `agent.task.run`（且仅任务超过 2 分钟才记）。
