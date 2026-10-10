# J 系：checkpointing 与 resume 语义（spec 2026-10-10-checkpoint-resume）

> **状态：J1/J3 完成，J2 驳回（核实后），J4 口径登记**（2026-10-10，分支
> c1009c27；测试 +7，全量 2162 全通过）。
>
> **先纠正任务书三处**：①「G1 仍未修」——G1 已在 c1009c24 修复；总序里的
> E1/E5/H1-H3/I1/I2/I5 也已全部完成（c1009c23-26）；② **J2 的场景在当前架构
> 不成立**（核实：聊天消息没有 toolCalls 字段——工具过程不进消息，只有
> toolStatus 行；"pending tool call 静默丢失"混淆了 Claude Code 的消息结构。
> 中断的事实记录只能来自 E4 事件流——J2 驳回，等 E4）；③ J3 核实结论：
> **mode 挂在全局 workspaceSettings**（ChatPanel state + patchWorkspaceSettings），
> 非 per-session——迁移方向如任务书所料。

## 现状基线（c1009c26 已核验）

- ✅ sessionBranches.js L70/L82：归档与分支读取 filter 掉 pending——**核实后修正
  解读**：聊天消息的 pending 是**流式占位**（assistant 半截文本），不是 tool call
  （消息无 toolCalls 字段）；filter 丢占位是**合理行为**（半截文本不值得保留），
  不改（改了反而引入空气泡）。
- ✅ 写系工具（write/edit）无写前快照——真缺口（J1）。
- ✅ 对话层回退链完整（撤回 → archiveBranch → BranchForkRow 切换）；撤回为用户触发。
- ✅ sessionCore.js 键结构与 enqueueSessionMutation 串行化完备。

## J1 文件层写前快照 ✅（与 H3 并存不合并）

- [x] 新模块 `src/workspace/fileHistory.js`：
      - 存储两文件分层：`index.json`（元数据数组，上限 200，超出丢最旧）+
        `entries/<id>.json`（单条旧内容）——读改写只动其一；
      - `recordFileHistory`（写入即记录，oldContent 空 = 新建，删除可逆；
        **单条内容超 256KB 只记元数据 + restorable: false**——防超大文件写爆）；
      - `listFileHistory`（按路径过滤，最新在前）/ `readFileHistoryEntry` /
        `restoreFileHistory`（**恢复前先快照当前**——天然可逆：恢复错了再恢复
        一次就回去）/ `historyRotationDeletes`（轮换基于**挤出前**的完整列表
        ——第一版从截断后列表算，旧条目文件会永远残留，测试抓出已修）。
- [x] 工具接线：`write_workspace_file` 与 `edit_workspace_file` 落笔前
      `snapshotBeforeWrite`（读旧内容用 8MB 宽上限——**截断内容不配当旧版本**，
      读不全的跳过快照并如实跳过记录）；失败不阻塞写入（尽力而为）。
- [x] **列表隐形**：`.easychat/file-history/` 从两后端的 listWorkspaceFiles 过滤
      （agent 的 list 工具 / 文件面板 / 压缩扫描都不看见；fileHistory 自己用
      直读，不依赖列表）——200 条快照不刷 UI。
- [x] 与 H3 的关系：**并存不合并**（修正任务书"并入"）——H3 的 rollback/<ts>.json
      是推送级快照（含 sha/commit 语义、已测试稳定），本模块是工具级（路径级）；
      数据格式与保留期不同，强行合并让两边测试互相掣肘。恢复入口各自独立。
- [x] 测试 6 条：元数据收敛/轮换纯函数、记录（新建记空/覆盖/列表过滤）、恢复
      （写回+先快照当前+超限如实拒+not-found）、轮换实测（收敛+旧条目清理）、
      旁路纪律（坏 store/空 path 不抛错）。
- [ ] 二期：文件面板「文件历史」恢复入口（数据层已备好，UI 是独立迭代）。

## J2 中断 tool call 语义化——**驳回**（核实后场景不成立）

- 核实：聊天消息**没有 toolCalls 字段**（工具过程不进消息——只有 toolStatus 行
  与最终 assistant 文本）；sessionBranches 的 pending filter 丢的是**流式占位**。
- 中断的事实记录只能来自 **E4 事件流**（工具调用事件落 jsonl 后才有"执行到一半"
  的证据）；E4 未落地前做 J2 的"注入提醒"= 无事实支撑的猜测性提示——违反
  「不说假话」纪律。
- **裁决**：J2 驳回；其真需求并入 **E4 验收口径**（见 J4：中断恢复 = 从事件流
  末态得出未完成工具调用）。sessionBranches 的 filter 维持原样（丢流式占位是对的）。

## J3 会话状态还原 ✅（存储层完成，消费端接线二期）

- [x] 核实报告（任务书要求的 5 分钟核实）：**mode 挂在全局** workspaceSettings
  （ChatPanel state + patchWorkspaceSettings 持久化，非 per-session）；**plan
  是 ChatPanel 内存 state**（A3 二期的 agentPlan，不持久化）→ 两项都需要还原链。
- [x] `sessionLibrary.normalizeSession` 加 `agentMode` 字段（只收 read/write；
  '' = 未设置跟随全局；ask 不存——默认态；老数据零迁移）。
- [x] `sessionCore.setSessionAgentMode`（幂等 + 缺会话/缺参数 false）+
  sessions.js barrel + storage.js 转发。
- [x] 测试：normalize 收敛（hacker/ask 拒收）+ 存取往返/幂等/边界。
- [ ] 二期（消费端）：聊天页恢复会话时读 agentMode 覆盖全局 + 切换时写入 +
  planSummary 随 A3 二期的 plan 持久化一起（plan 尚无持久化形态）。

## J4 E4 验收口径补充 ✅（登记，不新开工）

E4 jsonl 开工时写进其验收标准（本轮裁决，勿丢）：
- 支持从事件 N 重构会话（resume to event N）；
- 支持从事件 N 分叉新会话（fork from event N）；
- 归档会话（I5）可只留 preview + 事件流文件路径，消息正文不占 AsyncStorage
  （6MB 压力的根治路径）；
- 保留期策略（类 cleanupPeriodDays）在 SAF 落地验证后再定数值；
- **J2 的中断恢复**：未完成的工具调用从事件流末态得出（本系裁决的归宿）。

## 明确不做（防跑偏清单）

本地 git / JGit / git 原语 checkpoint / 每 turn 自动建分支 / 多维度恢复合并菜单 /
file-history 对 agent 开放写权限（恢复入口不做 agent 工具——防模型篡改历史）。

## 门禁

五门禁全绿（全量 2162）；纯函数 Node 直测先行（fileHistory 全链、agentMode 收敛
与幂等）；i18n 0 新词条（本轮无 UI 文案——恢复入口二期）；file-history 不进
列表枚举有测试钉死（隐形历史）。
