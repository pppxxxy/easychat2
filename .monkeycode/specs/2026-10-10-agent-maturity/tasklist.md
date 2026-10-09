# Agent 成熟度 E 系 任务清单（基于 d165ba3f 全面对比后的裁决）

> **状态：E1–E5 全部完成**（2026-10-10，分支 c1009c23；测试净增 26，全量 2127 全通过）。
> 实施记录与实际取舍见文末「实施记录」。

> 六产品对比（Claude Code / Codex / OpenCode / DeepSeek Harness / ZCode / Cursor 类）
> 后收敛为四个真差距：缓存经济学、事件流会话、子代理体系、行为护栏。
> 明确不做：LSP（Android 无 node 运行时）、PTC（与 riskGate 架构冲突）、多端（定位）。

## 代码事实基线（d165ba3f 已逐条核对）

- ✅ prompt caching 零痕迹（全仓 rg 无 cached_tokens/cache_control 命中）——E1 真缺口。
- ✅ `chat/replyFlow.js` trimHistoryByBoundary 存在；压缩在 `chat/compaction.js`
  （4MB / 保留最近 6 条 / stale 降级）——但 **shouldCompact / shouldAutoCompact
  只在定义处，无调用**：压缩目前只有手动按钮（ChatScreen.handleCompactSession）
  → E2 的自动触发是真缺口。
- ✅ `agent/loop.js` 无 usage 处理（makeResult 只有 text/reasoning/toolCalls/finishReason）
  → E1 usage 管道要跨层新建。
- ✅ **E1 审计发现**：`workspace/chat.js` 中 readLog 行（每轮最高频动态项）位于
  systemPrompt 中部（memory 之后、skills 之前）——它一变，之后所有内容 + 全部
  history 的缓存前缀全碎。需挪到 systemPrompt 最尾。
- ✅ skills allowed-tools（D1）、hooks 四事件含 on_tool_result（D4-1）、
  restApi Retry-After/AbortController（C4）、repoPush Trees API（C3）均已落。
- ✅ 分支系统真相（修正任务书认知）：**「撤回尾段归档 + 任意点切换」已完整存在**
  （`chat/branchTree.js` branchFromTail/planCheckout + `storage/sessionBranches.js`
  + `BranchForkRow` 按消息渲染入口）——E4 二期"任意点分叉"本质已具备，
  真缺口只剩**事件流审计**（append-only jsonl）。
- ✅ 子代理：名字白名单防递归 + SUBAGENT_MAX_ROUNDS=6（E3 地基已备）。
- ✅ sessionStats.js：recordRequest/summarizeStats 可扩展（加 cachedTokens）。

## E1 缓存前缀稳定 + 命中观测（P0，最高 ROI）

- [ ] 1. `workspace/chat.js`：readLog 行从 systemPrompt 中部挪到最尾（静态段前置、
      高频动态段后置）；行序契约进测试。
- [ ] 2. tools 顺序冻结：`toolOrderSignature` 纯函数 + ChatPanel 会话内运行期兜底
      （同一 mode 下顺序漂移 → 开发期 warn）。
- [ ] 3. `network/api.js`：`extractUsage` 纯函数（OpenAI prompt_tokens_details.cached_tokens /
      DeepSeek prompt_cache_hit_tokens / Anthropic cache_read_input_tokens 三方言，
      Anthropic 形态把 cache 部分并进 prompt 以统一口径）；流式每事件与
      非流式 body 都提取；makeResult 带 usage。
- [ ] 4. `agent/loop.js`：每轮结果透传 options.onUsage({ round, ...usage })。
- [ ] 5. `chat/sessionStats.js`：recordRequest/normalizeStats/summarizeStats 支持
      cachedTokens + 命中率；`chat/SessionStatsModal.js` 显示。
- [ ] 6. 宿主接线：useChatSend / ChatPanel 把 onUsage 累进 recordRequest。
      注：**不做价格换算**（BYO 端点无统一价格表，显示绝对 token 数与命中率更诚实）。

## E2 重复调用护栏 + 压缩自动化（P0，小时级）

- [ ] 1. `agent/loop.js`：上一轮 toolCall 签名（name+args）跟踪，连续相同签名在
      执行前注入 nudge（非阻断）。
- [ ] 2. 压缩自动化：token 估算超活动模型窗口 70% → 非阻塞提示；85% → 自动压缩
      （设置可关）。复用 compaction 管道；接 shouldAutoCompact（现在是死代码）。

## E3 自定义子代理 + 并行（P1）

- [ ] 1. `.easychat/agents/<name>.md` frontmatter（name/description/tools/max-rounds）；
      tools ∩ 只读白名单，run_subagent 永不可入。
- [ ] 2. run_subagent 参数加可选 agent 名；描述里列可用分身（渐进披露一行）。
- [ ] 3. task 支持数组（≤3）并发（上限 2），按序合并；timeoutMs 180→300。

## E4 会话事件流（P1，一期可独立发布）

- [ ] 一期：`.easychat/sessions/<id>.jsonl` append-only（type/ts/parentEventId）；
      SAF 落盘；设置页导出（分享）。
- [ ] 二期裁决（已核实）：消息级分叉/切换已存在（branchTree+sessionBranches），
      **不另起一套**；事件流只做审计线索，不接分支树。

## E5 Git 历史浏览 + PR（P2，纯 API）

- [ ] 1. restApi：listCommits / getCommitDiff / createPullRequest。
- [ ] 2. GithubPanel「历史」区块：commit 列表 → diff（大 diff 复用头尾截断）。
- [ ] 3. push 成功后「去创建 PR」入口（确认门 + riskGate 分级）。

## 明确不做（防跑偏登记）

LSP（Android 无语言服务器运行时；轻量替代=AGENTS.md 引导 py_compile 自检）、
PTC 程序化工具调用（与 riskGate 双门冲突）、逐 token 流式工具结果、多端、生态市场。

## 实施顺序

E1 → E2 → E5 → E3 → E4（E1/E2 先做，E4 一期可独立发版）
