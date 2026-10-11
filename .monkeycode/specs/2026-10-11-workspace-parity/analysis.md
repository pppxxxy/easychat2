# Agent 工作区对照分析：EasyChat2 vs ZCode / Claude Code / DeepSeek Harness

> 维度：**功能 / 结构 / 图形化操作便利程度**。基准：`m1010m8`。
> 参考：ZCode 开源版（zai-org/ZCode）、Claude Code 泄露源码、DeepSeek Harness（dsh，开源 + 桌面/Web GUI）。

## 0. 三条参考的定位与界面

- **Claude Code**（泄露源码）：CLI/TUI（Ink/React）+ IDE 扩展 + headless/SDK。**18 个内置工具**。**无独立 GUI**（终端 + IDE 面板）。
- **DeepSeek Harness (dsh)**：everything-is-a-plugin（Cordis）。**Web UI**（`127.0.0.1:3080`）+ **Desktop app**（Mac/Windows）。界面含 Settings→Models / Choose workspace / session composer / 审批 / **插件 + creator mode（自定义面板、免重启）** / **自动化任务（定时）** / **HTML 报告预览**。另 headless/TUI/ACP/JSON-RPC/Python·TS SDK。
- **ZCode**（开源）：desktop + browser + terminal 三端 workspace；monorepo（clients + backend + shared UI + agent CLI/runtime）；多智能体编排、1M 上下文、权限 broker、移动 bot。
- **EasyChat2（我们）**：移动端（Expo）App；工作区**单屏五领域**（对话 / 文件 / GitHub / 终端 / 设置）。

## 1. 功能差距

### 1a. 工具面（Claude Code 18 个 vs 我们 14+2）
Claude Code 有而我们没有：
- **NotebookEdit**（Jupyter notebook 编辑）。
- **BashOutput / KillShell**（后台进程的读取与终止）——我们 `run_shell` 是**同步**的，**无后台进程管理**。
- **AskUserQuestion**（任务中途**主动问用户**）——我们只有审批弹框，agent 不能主动提问。
- **EnterPlanMode / ExitPlanMode**（显式计划模式开关）——我们用 `update_plan` + read/write 模式近似。
- **Skill / SlashCommand 作为「模型可调用的工具」**——我们的技能/命令是提示注入 / 用户触发，**模型不能主动 invoke**。

我们有而 Claude Code 原生没有（或更弱）：**run_workflow（依赖 DAG）**、**可写子代理**、**MCP resources/prompts**、**主动消息 / 定时 Agent 任务**、**看屏悬浮窗**、**本地模型**。

### 1b. 能力面
- **后台进程**：Claude Code 有；我们无。
- **中断提问**：Claude Code 有（AskUserQuestion）；我们无。
- **计划模式**：Claude Code 显式（Enter/ExitPlanMode）；我们 update_plan + 审批。
- **UI 插件化**：dsh 的 creator mode 能**装插件扩展界面**；我们无。
- **报告产物**：dsh 能生成并在 App 内**预览 HTML 报告**；我们导出 .docx / 长图。
- **程序化驱动**：dsh 有 ACP/JSON-RPC/SDK；我们只有 JS 事件协议（HTTP endpoint 待做）。
- **多端**：dsh/ZCode 有桌面/web；我们只有移动端。

## 2. 结构差距

- **架构范式**：dsh「一切皆插件」（Cordis）；我们是 Expo App + 领域拆分（`src/agent`、`src/workspace`、`src/chat`…）。我们的**扩展点是声明式文件**（SKILL.md / commands / agents / hooks.json），不是**可编程插件包**。
- **端结构**：ZCode 是 monorepo（clients/backend/shared UI/CLI）；我们是单 App。
- **UI 结构**：dsh/ZCode 是**多面板桌面布局**（文件树/编辑器/diff/终端分栏）；我们是**单屏五领域**切换。
- **上下文**：ZCode 主打 1M；我们默认 200k + 压缩。

## 3. 图形化操作便利程度差距

| 能力 | Claude Code | dsh | ZCode | 我们 |
|---|---|---|---|---|
| 独立 GUI | 无（TUI/IDE） | Web + 桌面 | 桌面+web+终端 | 移动 App |
| 文件树 | — | ✓ | ✓ | 列表（无树） |
| 富编辑器/语法高亮 | IDE 里 | ✓ | ✓ | 无（只读展示） |
| Diff 视图 | ✓ | ✓ | ✓ | 文件历史（弱 diff） |
| 终端面板 | ✓(TUI) | ✓ | ✓ | 终端领域（run_shell） |
| 多面板布局 | 无 | ✓ | ✓ | 宽屏分栏 / 窄屏单屏 |
| UI 插件/自定义面板 | 无 | ✓ | 部分 | 无 |
| 审批/权限 UI | ✓ | ✓ | ✓ | ✓（三选项弹框） |
| 计划进度 | TodoWrite | ✓ | ✓ | ✓（进度条） |
| 报告预览 | 无 | ✓(HTML) | ✓ | ✓（md/HTML 渲染，可切原文） |
| 移动端 | 无 | 无 | bot | ✓ |

## 4. 规划（按性价比）

**P0（移动端可做、高价值）**
1. **AskUserQuestion 工具**：让 agent 任务中途能主动问用户（复用审批弹框 + 输入框）。
2. **后台进程管理**：`run_shell` 支持后台任务 + `bash_output` / `kill_shell`（原生配合 + JS 契约 + UI 展示）。
3. **Skill / SlashCommand 作为模型工具**：让模型能主动 invoke 技能/命令（我们已有声明式定义）。

**P1（GUI 便利）**
4. **工作区文件树**（可折叠）+ 富 diff 视图（复用 `fileHistory`）。
5. ~~**多面板/分栏**（平板/横屏）或标签页（移动端单屏下的便利提升）~~ **已做**（2026-10-11）：宽度 ≥ 720 时左右分栏（对话常驻 + 选中领域并排），窄屏维持单屏切换（左栏即标签）；判定纯函数 `src/workspace/layout.js`。

**P2（结构）**
6. **可编程插件**（hooks 之外的 plugin 包）——把声明式扩展升级为可加载插件。
7. ~~**HTML 报告预览**（dsh 式）~~ **已做**（2026-10-11）：工作区文件预览按扩展名渲染——`.md`/`.html` 复用聊天页 `AssistantMessageBody`（Markdown / 富 HTML WebView），可一键切「查看原文」；分类纯逻辑在 `src/workspace/filePreview.js`。

**P3（原生/大工程）**
8. ③ 原生 `POST /v1/agent` endpoint（程序化驱动）。
9. 桌面 / Web 端（与移动端共享 agent 内核）。

## 5. 一句话

功能上我们**已补齐主流工具面**（缺 NotebookEdit / 后台进程 / AskUserQuestion / 显式计划模式 / 模型可 invoke 技能）；结构上我们从**声明式扩展**走向**可编程插件**；GUI 上我们从**单屏移动端**补**文件树 / diff / 报告预览 / 分栏**。移动端是我们的**差异化优势**（三参考都没有移动端）。
