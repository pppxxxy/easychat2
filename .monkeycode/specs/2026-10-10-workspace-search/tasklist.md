# M 系：工作区搜索工具 + 读指引修复（spec 2026-10-10-workspace-search）

> 状态：**M0 + M1 完成**（2026-10-10，分支 m1010m2）。外部工具对照表（Operit 16 工具）
> 经核验：`readfilepart` / `make_directory` 两项「真缺」为误判（分页读闭环与
> `create_workspace_dir` 均已在 main），`visit_web` 工具化基本作废（webSearch 已是
> registry chatTool）。真实缺口收窄为搜索工具族；核验另发现一处参数名指引 bug（M0）。

## 现状基线（核验，勿重做）

- 完整工作区工具清单：`list_workspace_files` / `read_workspace_file` /
  `search_workspace`（本系新增）/ `update_plan` / `materialize_repo` /
  `get_build_log` / `run_subagent` / `create_workspace_dir` / `write_workspace_file` /
  `edit_workspace_file` / `run_remote_build` / `export_workspace_docx`
  （+ 条件注册的 `run_shell` / `run_python`；另有 MCP GitHub 套件与 webSearch chatTool）。
- `read_workspace_file`：`offset`/`limit` 分页 + 截断续读提示 + A5 已读登记——闭环完整。
- `messages.js` `serializeToolResult`：16KB 头尾保留 + 按工具名分派续读指引。
- 无任何搜索类工具：agent 找代码只能 list 全量 + 逐文件 read。

## 裁决记录（防反复）

1. `readfilepart` / `make_directory` / `visit_web` 三项外部建议作废。
2. 搜索是唯一真缺口：`find_files` 并入 `list_workspace_files` 的 `match` 参数
   （不建新工具）；grep 单独立 `search_workspace`（返回带上下文行的片段）。
3. `delete_workspace_file`：确认缺失，但删除必须挂 J1 写前快照——列为 J1 的可选
   扩展项，本系不做。
4. `sleep` 工具：可选顺手项，不单独立项，本系未做。
5. `download_file` / `use_package`：明确不做。

## M0 读指引参数名修复

- [x] `src/agent/messages.js` `serializeToolResult` 的 `read_workspace_file` 指引：
      `offset/maxChars` → `offset/limit`，与工具定义实际参数对齐。
- [x] 顺检 `readTools.js` 提示文案：续读提示只写 `offset`，描述已写 `offset/limit`，无第二处。
- [x] 断言测试（`tests/agentMessages.test.mjs`、`tests/workspaceSearch.test.mjs`）。

## M1 工作区搜索工具

- [x] `list_workspace_files` 加 `match` 参数（可选，文件名子串，不区分大小写；给出时
      结果不含目录项）。过滤在遍历时生效（先过滤再套 MAX_FILES/MAX_DEPTH 上限）。
- [x] 截断可见：`listWorkspaceFilesWithMeta` 返回 `{ files, truncated }`；命中上限时
      工具输出附「已达上限 2000 条，结果可能不完整；可用 subdir 或 match 收窄范围」。
      legacy（`store.js`）与 SAF（`safStore.js`）两后端同口径；桩后端只有旧方法时退化。
- [x] 新工具 `search_workspace`（`src/workspace/toolDefs/searchTool.js`）：
      参数 `pattern`（必填）/ `regex`（默认字面量）/ `subdir` / `contextLines`（默认 2，
      上限 5）/ `maxMatchesPerFile`（默认 20，上限 100）。
- [x] 纯扫描 `searchWorkspaceText`：grep 风格 `file:line:` 匹配行 + `file-line-` 上下文行；
      相邻匹配上下文重叠去重；同一行既命中又是上下文时按「命中」显示。
- [x] 单文件超 `maxMatchesPerFile` 汇总「N 处匹配，已列前 M 处」；总输出预算 8KB；
      总时间预算 2s（`now` 可注入，超时返回已完成部分 + 标注）。
- [x] 防御：正则编译失败返回友好错误（提示改用字面量）；空 pattern 报错。
- [x] `serializeToolResult` 指引分派追加 `search_workspace` 条目。
- [x] 测试：`tests/workspaceSearch.test.mjs`（命中矩阵 / 上下文 / 双预算 / 时间预算 /
      坏正则 / match 过滤 / 截断告警 / 指引文案）。

## 明确不做

重造分页读 / 重造建目录 / webSearch 二次工具化 / `download_file` / `use_package` /
glob 通配语法 / 无快照删除工具 / 搜索结果走 UI 富渲染（v1 纯文本）。
