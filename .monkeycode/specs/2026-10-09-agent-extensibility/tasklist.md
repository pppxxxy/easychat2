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
- [ ] T5 斜杠命令 `/name $ARGUMENTS`（输入框匹配列表 + 模板渲染纯函数）
- [ ] T6 钩子 hooks.json（声明式，before_shell/after_write/after_edit；不做任意 JS 插件）

## 阶段 3：体验对齐
- [ ] T7 持久 shell 会话（先方案 B：会话记 cwd + .easychat/env.json；PTY 登记待办）
- [ ] T8 子代理 run_subagent（只读白名单默认；硬红线：不得递归）
- [ ] T9 工作区模板（空白 / Python / 静态网页）

## 登记
- 阶段排序刻意：T1 是最大乘数（GitHub 变成第一个「插件」），T2/T3 是支柱（自演进指令 + 权限记忆）。
- T6 明确不做任意 JS 执行插件（RN 无安全沙盒）→ 审查待办留痕。
- T7 PTY 若成本不成比例走方案 B，PTY 登记待办，不硬上。
