# AS2：工作区助手代改设置确认系统（多题卡组）
## 目标
给用户一个比 ask_user 更强力的「确认」方式——一次发 1–4 道题，每题除了「是/否」外还能给「其他」三种形态：
• list：候选列表点选（角色库等长清单由宿主注入真实选项，防模型编造 id）
• edit：预填文字可编辑（默认内容直接进 input box）
• free：空输入框
答案整体结构化回传：`[{id, answer: 'yes'|'no'|'custom', custom?: string}]`。

## 设计原则
• **与 ask_user 共存**：ask_user 保留（轻量选择题、Alert 三按钮），confirm_flow 用于复杂场景（早报需要选角色+改措辞两题）。
• **对话框内联而非 Modal**：卡片在对话流里渲染（ConfirmBar 同款形态），不碰 R6 遗留的 Android 手势雷区（列表塞进弹窗背景层会被 Pressable 领走 responder）。
• **模块级桥隔离 UI**：会话挂起与结算逻辑住在 `confirmFlowBridge.js`，面板只订阅渲染；即使面板被卸载重建（切领域），桥也不丢状态，agent 不会因为「没人答」而永远卡死。
• **幽灵卡防护**：工具超时放弃时，桥自动按取消结算题卡（避免永远挂着）；换卡后旧卡定时器不误杀新卡。

## 文件结构
| 路径 | 职责 | 测试 |
|---|---|---|
| toolDefs/confirmFlow.js | 纯逻辑（归一/校验/格式化）：Node 直测 | confirmFlow.test.mjs |
| toolDefs/confirmFlowTool.js | 工具定义 + execute：透传 confirmFlow钩子与choices源 | confirmFlow.test.mjs |
| screen/confirmFlowBridge.js | 模块级桥（挂起/提交/取消/幽灵卡）：Node 直测 | confirmFlow.test.mjs |
| screen/ConfirmFlowSheet.js | 界面（对话流内题卡组）：ConfirmBar 同款 | confirmFlow.test.mjs |
| screen/SessionSidePanels.js | 装配：订阅桥渲染卡组 | mcpServer/MCPServer.test.mjs（接线断言） |
| settings/mcpServer.js | serverPolicy 登记为 hidden（MCP 会话无人答题） | mcpServer.test.mjs |
| locales/{zh-CN,en}/confirmFlow.js | 词条独立域（workspace 已顶棘轮上限） | confirmFlow.test.mjs |

## 技术细节
### 1. 归一化与校验（纯模块 confirmFlow.js）
- 题卡 1–4 题：非数组/超上限/全非法 → 空数组（工具报 isError）。
- 缺省 id 补号必须避开占用（含模型显式给的 id），否则撞车静默丢题→ 补到未占用的 qX。
- 选项 ≤30 个；文本截断至 CONFIRM_FLOW_TEXT_MAX=200（edit 预填 2000 字符）。
- list 题：agent 只写 source 名，真实选项由宿主 ctx.choices(source) 注入（防编造）。
- 答案：每个问题必须有合法 answer（yes/no/custom）；custom 必须带非空文本。

### 2. 模块级桥（confirmFlowBridge.js）
- **挂起**：requestConfirmFlow({ questions, timeoutMs=300000 })；返回 Promise 等待 agent 循环。
- **订阅**：useSyncExternalStore(subscribeConfirmFlow, getPendingConfirmFlow)；面板得快照并渲染。
- **提交/取消**：respondConfirmFlow([answers]) 或 cancelConfirmFlow() 结算 Promise；同时清除 timer。
- **幽灵卡防护**：超时自动按取消结算（与工具 timeoutMs 同预算）；旧卡定时器只结算自己（不误杀换卡后的新卡）。
- **超时归一**：非法值（NaN/字符串）→ 默认 5 分钟；显式 0 或负数→不设超时。

### 3. 界面（ConfirmFlowSheet.js）
- **对话流内联**：非 Modal；ConfirmBar 同款视觉（卡片+底部提交/取消条）。
- **每道题**：[是][否][其他?] 三按钮；其他点开展开成：
   - list：滚动列表（maxHeight 裁剪）
   - edit：多行输入框（预填 text，onEndEditing 触发但不依赖它置 answer）
   - free：单行输入框
- **提交归一**：没选是/否但输入框里有字 → 视作 custom（解决 Android 多行输入点提交不一定先失焦的问题）。
- **未作答提示**：缺失几题就显示「还有 N 题没作答」。

### 4. 注册表透传（tools.js / loop.js）
- 工具定义 registerTool(...) 中注入执行器；execute(args,ctx) 调用 host 的 confirmFlow 钩子。
- host options 里透传 choices('characters') 映射角色库为 id+label 列表（model 只写 source）。

### 5. 门控策略（serverPolicy.js）
- confirm_flow 进 HIDDEN_TOOLS：MCP 会话里没人答题，问也没用，只暴露给 App 内 agent。

## 端到端流程
1. 用户在聊天里说「每天早上10点整理橘鸦AI早报」（假设工作区 mode=write）。
2. 模型发起 confirm_flow 工具，arguments.questions=[{text:'由当前的角色来吗',other:{type:'list',source:'characters'}},{text:'要润色吗',other:{type:'edit',prefill:'整理橘鸦AI早报'}}]。
3. 注册表 runTool 调 host.confirmFlow(requestConfirmFlow)，host 传入角色列表作为 choices source。
4. 桥挂起 Snapshot（含角色候选），SessionSidePanels 渲染卡组（角色题下拉「橘鸦/小助手」、润色题预填「整理橘鸦AI早报」）。
5. 用户点选「橘鸦」、修改润色内容「整理橘鸦AI早报，加上天气」，点击提交。
6. respondConfirmFlow([{id:'q1',answer:'custom',custom:'橘鸦'},{id:'q2',answer:'custom',custom:'整理橘鸦AI早报，加上天气'}]) 结算 Promise。
7. 工具执行完成，返回 content="用户确认结果：\n由当前的角色来吗 → 其他：橘鸦\n任务内容需要润色吗 → 其他：整理橘鸦AI早报，加上天气"。
8. agent 继续下一步（调用定时任务工具 set_scheduled_task）。

## 真机验证清单
• 会话里下命令触发明卡（角色选项被宿主注入）→ 正确。
• 编辑题预填可改 → 正确。
• 多题作答（全选/单选/部分）→ 正确。
• 中途取消（关掉弹窗）→ 工具返回「用户取消了确认」。
• 工具超时（5 分钟）→ 桥自动取消，题卡消失。
• 换卡（第二次 confirm_flow）→ 旧卡不被新定时器误杀。
• MCP 会话 → confirm_flow 不可见（hidden 策略生效）。

## 测试覆盖
- 纯逻辑：normalize*系列（归一规则）、validateConfirmAnswers（校验）、hydrateConfirmQuestions（宿主注入）。
- 桥：挂起/提交/取消、超时自动结算、幽灵卡防护、timeoutMs=0 关闭超时、新旧卡隔离。
- 工具：runTool 全链、无宿主钩子拒绝、畸形参数拒绝。
- 接线：SessionSidePanels 订阅、workspacesNative/toolsLayering 清单一致性。
- 词条：confirmFlow 域 zh/en 完整。

## 已知限制
• 最大 4 题（超出部分丢弃，工具报错），最多 30 个候选项。
• 文本上限：题面/标题/自定义文本 200 字符（超长截断），edit 预填 2000 字符。
• 不会做异步 IO：host 注入的角色列表必须是内存中的数组（同步获取），否则模型会看到「加载中…」的空状态。

## 未来优化方向
• 支持「其他」类型扩展：如日期选择器/数值范围滑块（当前只有三个基础型）。
• 增加「预览模式」：提交前可看一遍所有作答再最终确认（减少手误）。
• 与计划进度条联动：确认卡在计划中间步骤出现时可以暂停轮询？（待定）。
