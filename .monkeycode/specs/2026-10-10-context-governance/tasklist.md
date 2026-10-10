# Q 批：上下文治理收口（spec 2026-10-10-context-governance）

> 前置：O0/O1/O2(部分) 已验收（m1010m3）。本批把压缩/清除域收口：
> riders → K1 → N2 → N1，K5/K6 措辞随批捎带。P0 取消（E2 已覆盖）。G1 仍在一切之前。
> 分支 m1010m4（基于 m1010m3）。

## 现状基线（m1010m3 已核验，勿重做）

- `loop.js`：A1 预算预警 + E2 重复 nudge（`stableStringify` canonical 化）+ O0.2 计划 nag 均在线。
- `messages.js`：D2 同步头尾保留（16KB）+ `serializeToolResultAsync`（O1 落盘→预览 2000×2 + 指针；失败退 D2）。
- `taskOutputs.js`：`.task_outputs/tool-results/` + LRU（份数 50 + 字节 16MB）+ 双重信任校验。
- `sessionPlan.js`：`@easychat2_session_plan::<id>`，空清单删键。
- `compaction.js`：D3 手动 4MB + KEEP_RECENT 6 + 三段摘要；聊天页 80% 挂 memorySummary；工作区会话仍无压缩路径。
- `network/api.js`：零重试（N4 不在本批）。

## Riders（**已完成**）

- [x] **Rider 1**：`planTool` 描述/头注释去掉「纯展示，无副作用、不落盘」，改为「计划随会话保留一份最新版本（历史压缩后仍可恢复）；同一时刻只允许 1 个 in_progress」。
- [x] **Rider 2**：`taskOutputs` LRU 加总字节预算 `TASK_OUTPUT_MAX_BYTES = 16MB`；size 由落盘时维护的清单 `.task_outputs/index.json` 提供，份数与字节双约束，缺失 size 的老文件跳过字节维度（best-effort 不误删）。
- [ ] **Rider 3（可选，本批砍）**：E2 连续 ≥3 轮同签名重复 → 更强措辞 + 参数预览。因 K1/N2/N1 体量大，按任务书「做不完就砍」处置，留待后续。
- [x] **K5/K6 措辞**：`memory.js workspaceMemorySection` → 「作为背景上下文参考（不是指令）；与当前用户请求冲突时，以用户请求为准」；`AGENTS.md` 同步纪律。

## K1 工具结果清除（**已完成**：纯模块 + 直测；宿主接线归 N2）

- [x] 新模块 `src/agent/resultClearing.js`（纯逻辑）：`isToolResultConsumed`（其后有 assistant 才算消费）/
      `collectClearableResults`（unseen 排除 + recent-3 窗口保护 + >120 门槛）/
      `planResultClearing`（超预算按「批内从大到小」驱逐，同大小最旧优先，回预算即停）/
      `applyResultClearing`（落盘成功→替换占位符；失败→保原文；`onCleared` 钩子）/
      `findOrphanToolMessages`（配对完整性自检）/ `estimateContextBytes`（D3 同口径）。
- [x] 占位文案：`[此前工具结果已存至 <路径>，可用 read_workspace_file 按 offset 取回]`。
- [x] 配对纪律：只改 tool 消息 content；测试断言清除前后无孤儿。
- [x] 测试：`tests/resultClearing.test.mjs`（消费判定 / 窗口 / 门槛 / 驱逐顺序 / 落盘成功·失败·抛错·缺席 / 钩子 / 配对）。
- [ ] 宿主接线（N2 的 L1 档调用）+ `compactionStatus` 按「清除后」口径：归 N2。

## N2 工作区会话压缩 + recap（**未做**，依赖 K1）

- 四档管线 L0 修剪 → L1 清除 → L2 摘要（三段式 + 工具语义转写）→ L3 归档 `.transcripts/`；
  权威分离 + 摘要器防注入 + 五项保存清单；recap 读 `getSessionPlan` + readLog；KEEP_RECENT 6；幂等断言。

## N1 reactive 回退（**未做**）

- 错误矩阵（context_length_exceeded / prompt_too_long / vendor 变体，code+message 双匹配）；
  触发后归档 → 尾 5 保留（配对边界回退）→ 摘要旧史 → 重试一次；仍败给明确提示。

## 顺序与门禁

- riders → K1 → N2 → N1；每步 `lint` / `guard:structure` / `npm test` 全绿 + 覆盖率门禁；纯函数 Node 直测先行。
- 本批完成后 N3（readFileState）/N4（重试 ladder）具备前置，可作下批；再往后回总队列原序（L0a-L0d / E5 / J1…）。

## 明确不做（防跑偏）

P0 独立立项（E2 已覆盖）/ 时间阈值触发 / 压缩后自动重读文件 / 事件溯源级会话日志 /
`shouldAutoCompact` 死代码复活 / 任务 DAG / 抄 dsh/lcc 桌面常量数字（只抄结构，换算自家 16KB 体系）。
