# Agent 能力升级 任务清单（c1009c15 之后的下一阶段）

> **状态：A0–A6 全部完成**（2026-10-09，分支 c1009c18；测试净增 16，全量 2057 全通过）。

> 来源：外部评审（与专用 Agentic Coding Harness 对比）→ 审核助手逐条核对代码事实后
> 收敛为四件事：**轮次预算 / 截断分级 / 规划与验证引导 / 工作记忆**。
> 全部增量实现，不推翻任何现有架构。
>
> **事实基线**（2026-10-09 核对，分支 c1009c18）：
> - `loop.js`：`DEFAULT_MAX_TOOL_ROUNDS = 5`，`options.maxRounds` 管道已存在但
>   **无调用方传值**；到顶强插 `CAP_NOTICE`——修复成本比评审暗示的低一个量级；
> - `toolDefs/readTools.js`（原 tools.js）：offset/limit 分页 + 「继续读取请用
>   offset=N」续读指针 + 工具描述教学**已存在**——评审要的机制文件读取侧不要重做；
> - `shell.js truncateShellOutput`：64KB **只保头**——报错通常在尾部，stderr 尾巴
>   被切等于丢诊断信息（真问题）；
> - `mcpTools.js MCP_RESULT_CHAR_LIMIT = 16000` 同样只保头；
> - `messages.js serializeToolResult`：16KB 截断句只有「（已截断）」；
> - `chat.js` 提示词：`计划|验证` 零命中——规划/验证引导确实缺失；
> - 子代理 `SUBAGENT_MAX_ROUNDS = 6`（保持不变——隔离刷屏是它的存在理由）。
>
> 评审中「仅 GitHub MCP / 无记忆 / 技能纯静态 / 16KB 一刀切 / 无终端」等判断基于
> 旧 main 快照，c1009c15（T1~T9）已解决，不追。

## 阶段 0：零代码（提示词层，与修复零冲突）
- [x] **A0 规划与验证闭环引导**
      chat.js 加两条约定（超 3 步先列步骤清单、改完必须跑一次验证并把结果写进结论）；
      memory.js 的 AGENTS.md 模板「约定与偏好」节同步加同义约定。
      纪律：提示词不进 i18n 词条表；不新增工具。

## 阶段 1：P0 循环与上下文（核心追赶项）
- [x] **A1 轮次预算制**
      默认 5 → 12；ChatPanel 传参（write 16 / read 10）、useChatSend 同款分档；
      CAP_NOTICE 两段式：剩 2 轮注入预警「开始收束结论」，到顶保留现有强插收尾句。
      子代理 6 轮不动。
- [x] **A2 截断分级 + 重读指引**
      shell：头 48K + 尾 16K（中间标注省略量与收窄建议，头尾长度守恒）；
      MCP：12K 头 + 4K 尾（保留缩小范围提示）；messages：截断句升级
      「（已截断：原长 X 字符；文件读取可用 offset 续读，命令输出可收窄后重跑）」。

## 阶段 2：P1 结构化规划
- [x] **A3 update_plan 工具**
      `toolDefs/planTool.js`（readOnly 纯回显无副作用）；参数
      `{ plan: [{ step, status }] }`；execute 格式化回显清单；capabilities 清单同步。
      二期（不在本任务）：计划状态接 ChatPanel 进度条。
- [x] **A4 内置验证提醒（复用 T6 hooks 机制）**
      hooks.js 加 `DEFAULT_HOOKS`（after_write / after_edit 默认提醒「改完记得跑验证」）；
      用户在 hooks.json 里**同键**（含空数组）可覆盖/关闭默认。

## 阶段 3：P2 工作记忆与经验沉淀
- [x] **A5 已读文件登记（会话级 working memory 最小版）**
      read 成功后登记 { path, chars, at }（会话内存，上限 30 条 LRU）；每轮系统提示
      附一行「本会话已读：a.js(3.2k)…」。价值：防重复读 + 提示「上文可能被截断过」。
- [x] **A6 /remember 内置命令（零新代码，组合 T5+T2）**
      `SAMPLE_COMMANDS` 加一条：提炼长期约定 → 用户确认后写入 AGENTS.md。

## 明确不做（已在审查待办留痕，防止后续重复评估）
1. 工具结果向量检索（工作区侧 token 成本不成比例）；
2. Plan DAG 依赖追踪（A0/A3 轻量引导覆盖 90% 场景）；
3. 上下文老化淘汰（先靠 A2 截断分级）。
