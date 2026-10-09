# agent-extensibility 任务清单

来源：审核助手任务书（2026-10-09）。铁律同仓库：纯逻辑 Node 直测 / 文案进双语词条 /
五门禁全绿 / 每任务登记审查待办。

## 阶段 1：扩展性地基

### T1 通用 MCP 多服务器（最高优先）
- [x] T1-a 存储域 `storage/settings/mcpServers.js`：列表 CRUD + 归一 + slug；
      密钥字段 `mcpToken` 登记 SECRET_FIELDS；GitHub 旧键幂等迁移为内置记录
- [x] T1-b 泛化：`mcp/client.js` 补 headers（错误文案去 GitHub 化）；`mcp/riskGate.js`
      分级分域（github=白名单不变 / 第三方=默认 CONFIRM + FORBIDDEN 全局硬禁）；
      `workspace/mcpTools.js` 多服务器注册（github_ 兼容前缀 / slug__ 命名空间）
- [x] T1-c Node 直测：会话工厂泛化（headers）/ 命名空间注册 / 第三方默认 CONFIRM /
      危险名跨服务器拒绝 / 迁移幂等；`useChatSend` 调用点更名
- [x] T1-d 设置 UI：设置页「MCP 服务器」卡（列表 / 添加并测试连接 / 启停 /
      目录摘要 / 删除）；`useMcpServers` hook + `McpServersSection` +
      searchIndex/深链接线；应用 connectResult/parseHeadersText 两个纯函数

### T2 工作区记忆文件（AGENTS.md 等价）
- [x] 根目录 AGENTS.md 注入系统提示（**每轮直读** + 8KB 截断）；agent 可自行修改（自我演进通路）
      —— 偏离设计书的「mtime 缓存」：agent 可能在上一轮里刚改过它，缓存一旦判断失误
      模型就按旧指令工作；直读一次沙盒 IO，成本可忽略（登记理由已进审查待办）。
- [x] 新建工作区生成模板（幂等、绝不覆盖已有文件）；capabilities 能力说明同步；
      三态测试（存在/缺失/超长）

### T3 权限规则引擎
- [x] `@easychat2_workspace_permissions`：rules[{effect, tool, match, scope}]（落盘 CRUD +
      会话内存 scope；损坏备份；两处调用点共用同一份规则，跨页共享授权）
- [x] 确认弹框三选项（拒绝 / **本次会话允许** / **永远允许**）——「仍每次确认」的原意
      （允许这次但不记规则）被「本次会话允许」覆盖：规则 match 是**该命令原文**（词边界），
      只放行同一条命令，不是放行整个工具，授权放大极其有限；Android Alert 上限 3 按钮，
      没有空间单列第四项（取舍已登记）。deny 最高优先（与顺序无关，测试钉死）。
- [x] `pathMatchesGlob` 纯函数（`*` 不跨层 / `**` 跨任意层含零层 / 大小写敏感）；
      commandPrefix 词边界匹配（`npm install` 不放行 `npm installx`——纯 startsWith 会
      静默放行一条没审过的命令）；字段驱动取原文（command/code → 前缀，path → glob）。
- [x] 撤销入口：工作区设置「已记住的授权」行（列表 + scope 区分 + 清除全部）——
      授权必须可撤销，否则「永远允许」点错一次就是没法回头的坑。

## 阶段 2：技能与命令层
- [x] T4 SKILL.md 渐进披露（清单注入 + 现有 read 工具读全文，零新工具）+ 技能面板 + 3 示例
      —— 存放 `.easychat/skills/<name>/SKILL.md`；每轮直读（目录不存在 = 1 次 list IO）；
      清单只在 read/write 注入（ask 无读工具，注入等于教模型说谎）；设置面板技能行
      （列表 + 安装示例，幂等不覆盖）；3 个示例覆盖「流程型 / 清单型 / 产物型」。
- [x] T5 斜杠命令 `/name $ARGUMENTS`（输入框匹配列表 + 模板渲染纯函数）
      —— `.easychat/commands/<name>.md`；发送时展开、气泡保存原文；命令**不进系统提示**
      （用户侧功能，展开文本才进请求）；未命中命令名一律不展开（`/a/b` 这类路径文本
      原样发送，绝不猜测）；无 `$ARGUMENTS` 占位符时参数追加末尾（不丢输入）；
      frontmatter 解析抽为 markdownFrontmatter.js 与技能共用；设置面板命令行 +
      3 示例（weekly/polish/explain，幂等不覆盖）。
- [x] T6 钩子 hooks.json（声明式，before_shell/after_write/after_edit；**不做任意 JS 插件**）
      —— `.easychat/hooks.json`；before_shell = 预置禁令（前缀词边界匹配，翻译成
      T3 的 deny 规则经 extraRules 注入——命中直接拒绝、连弹框都不弹，复用既有
      「deny 最高优先」链路零新增裁决路径）；after_write/after_edit = 事后提醒
      （路径 glob 命中，追加进工具结果给模型看）；非 JSON / 畸形条目安全降级为空；
      每事件上限 20 条；agent 可读写（只能收紧不能放宽：block 更严、notify 只是信息）。
      不做 JS 插件的理由：RN 无安全沙盒（进程内 eval 触达全部原生桥）→ 已在审查待办留痕。

## 阶段 3：体验对齐
- [x] T7 持久 shell 会话（先方案 B：会话记 cwd + .easychat/env.json；PTY 登记待办）
      —— `.easychat/env.json`（cwd 相对路径 + env 注入）；agent 的 run_shell 包装执行：
      重放上次目录（失效回落根）→ 原样命令 → 捕获结束目录（写绝对路径）→ **保留退出码**；
      捕获目录在沙盒外一律不记（`cd /` 后不让后续命令都在 / 下跑）；含 `..` 的 cwd 丢弃；
      输出附「当前目录」一行（模型必须知道自己在哪）；env.json 与终端面板**共享**
      （用户在终端 cd，模型下一条就在那儿；反之亦然）；无 store 走原样执行（零行为变化）。
      PTY（真交互式会话：vim/top）登记为待办，不在本方案内；能力说明如实写边界。
- [x] T8 子代理 run_subagent（只读白名单默认；硬红线：不得递归）
      —— `agent/subagent.js` 独立循环（与主循环同款消息适配，抽 `agent/messages.js` 共用）：
      子代理只读、多轮迭代、只交回结论（中间过程不占主对话上下文）；轮次上限 6、
      结论 8KB 截断、工具结果 8KB 截断；工具报错喂回不中断；**防递归是结构性的**：
      按**名字白名单**过滤（run_subagent 自己也是 readOnly 工具，只看标志会放进来），
      且本模块不 import 注册表；网络层**惰性 require**（工具定义测试在纯 Node 里跑，
      静态拉网络层会把 expo-file-system 拖炸——实测踩过）；工具超时 180s。
- [ ] T9 工作区模板（空白 / Python / 静态网页）

## 登记
- 阶段排序刻意：T1 是最大乘数（GitHub 变成第一个「插件」），T2/T3 是支柱（自演进指令 + 权限记忆）。
- T6 明确不做任意 JS 执行插件（RN 无安全沙盒）→ 审查待办留痕。
- T7 PTY 若成本不成比例走方案 B，PTY 登记待办，不硬上。
