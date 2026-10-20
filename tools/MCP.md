# 把 easychat2 接进外部 agent（MCP）

easychat2 内置了一个 **MCP Server**：App 自己当服务端，把工作区工具（读文件、搜索、
git、shell、扩展包）暴露出去，外部 agent 连进来就能操作手机上的工作区。

协议层在 `src/mcp/server.js`（纯 JS），原生只做 HTTP 解析 + Bearer 鉴权 + 事件转发
（`plugins/mcpServer/android/McpServerModule.kt`）。所以**改协议不需要重新编译原生**。

## 一、在 App 里开启

`设置 → MCP 服务器 → 内置 MCP Server`

| 项 | 建议值 | 说明 |
|---|---|---|
| 启用服务器 | 开 | 关了原生根本不监听端口 |
| 访问范围 | 仅本机 / 局域网 | 见下方「两种连法」 |
| 端口 | 8737（默认） | 改端口后要重新复制连接配置 |
| Bearer token | 留空自动生成 | 别贴进公开聊天/截图/日志 |
| 工具档位 | 先只开「允许读取」 | 见下方「三档」 |

点「复制完整连接配置」，会得到：

```
easychat2 MCP Server: 1.0.0
Preferred access: direct HTTP JSON-RPC
Server URL: http://192.168.x.x:8737/mcp
Authorization: Bearer <token>
```

## 二、两种连法

### A. 同一台手机（最安全）

访问范围选「仅本机」，地址是 `http://127.0.0.1:8737/mcp`。
只有这台设备能连，不经过任何网络。

### B. 局域网（PC 上的 agent 连手机）

访问范围选「局域网」，地址是 App 显示的那个 `http://192.168.x.x:8737/mcp`。

⚠️ **明文 HTTP + Bearer token**：谁拿到 token 谁就能调用工具。
不要在公共 Wi-Fi 上开，用完就关。

## 三、用命令行验证连通（推荐先做这步）

`tools/mcp-bridge.mjs` 是一个 CLI 桥：它复用 App 自己的 `src/mcp/client.js`，
把 MCP 调用收敛成一条命令。**任何能执行命令的宿主都能借此接入**，不需要原生 MCP 客户端。

```bash
# 1) 握手 + 列工具（确认连通，不需要任何工具档位）
node tools/mcp-bridge.mjs --url http://192.168.1.5:8737/mcp --token <token> ping

# 2) 看工具全貌（含 inputSchema）
node tools/mcp-bridge.mjs --url ... --token ... list

# 3) 调用工具（参数用文件传，见下方「Windows 注意」）
node tools/mcp-bridge.mjs --url ... --token ... --args-file args.json call read_file

# 4) 读 App 自带的四份说明文档
node tools/mcp-bridge.mjs --url ... --token ... docs
```

退出码：`0` 成功 / `1` 调用或协议失败 / `2` 参数错 / `3` 连不上。

### Windows 注意

**不要把 JSON 内联在命令行里。** PowerShell 会把双引号吃掉，实测
`'{"path":"x"}'` 传进去变成 `{path:x}`，报「参数不是合法 JSON」。
用 `--args-file` 传文件。桥会自动剥掉 BOM（`Out-File -Encoding utf8` 会写 BOM，
JSON.parse 见到它直接报错）。

## 四、三档工具

| 档位 | 内容 | 默认 |
|---|---|---|
| 只读 | 读文件、搜索、看 git 状态与日志、读公告板 | **开** |
| 写入 | 建目录/写文件/精确替换、物化仓库、导出 docx、git 提交与回滚 | 关 |
| 执行 | 跑命令、跑 Python、触发云构建、装扩展包、子代理/团队/工作流 | 关 |

写入与执行类工具**第一次调用只返回预览**，agent 要带 `confirm: true` 重发才会真的执行。
这是协议层强制的（`src/mcp/serverPolicy.js`），不是靠 agent 自觉。

删除 / 强推 / 管理类操作即使 confirm 也**永远禁止**。

## 五、接进具体 agent

### Codex / Claude Code / Cursor

它们有原生 MCP 客户端。以 Claude Code 为例，在项目或用户级配置里加：

```json
{
  "mcpServers": {
    "easychat2": {
      "type": "http",
      "url": "http://192.168.1.5:8737/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

具体字段名各 agent 略有差异（有的用 `transport`、有的要 `--mcp-server` 参数），
以对应 agent 的文档为准。

### DeepSeek Harness（DSH）——**原生支持，不要用 CLI 桥**

DSH 自带 `@deepseek-ai/dsh-mcp-client`（在发行包的 `dsh/node_modules/@deepseek-ai/` 下，
**无需另外安装**），原生支持 `streamable-http`。配置写在 **profile 的
`cordis.patch.yml`** 里（不是 `cordis.yml`——那个文件头写着「编辑 patch，不要编辑我」）：

```yaml
- id: mcp-easychat2
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: easychat2
    transport: streamable-http
    url: http://192.168.3.8:8737/mcp
    headers:
      Authorization: 'Bearer <token>'
    # 手机侧子代理最长 300s，默认 60s 会把慢工具误杀成超时。
    toolCallTimeoutMs: 300000
    # 手机可能没开、可能换网：连不上不要拦住 DSH 启动。
    failOnStartupError: false
```

工具以 `mcp__easychat2__<tool>` 出现（与 Claude Code、Codex 同一命名形态）。
**改完必须重启 DSH** 才生效。

找 profile 目录：`$env:DSH_PROFILE_DIR`（本机是 `D:\dsh\profiles\desktop`）。

### 没有原生 MCP 客户端的宿主

用 `tools/mcp-bridge.mjs`：宿主通过 shell 调用它，等价于接入。
（DSH **不属于**这一类，它有原生客户端；桥在这里只剩「不依赖宿主配置的排查工具」价值。）

## 六、排查清单

| 现象 | 原因 | 处理 |
|---|---|---|
| `ECONNREFUSED` | 端口没开 / 服务没启动 | 确认 App 里「启用服务器」真的开着；开关起不来会**自动回滚为关闭**并显示原因 |
| `EHOSTUNREACH` / `ETIMEDOUT` | 不在同一局域网 / AP 隔离 | 确认手机与 PC 同一网段；关掉路由器的「AP 隔离」 |
| `401` | token 不匹配 | 重新复制连接配置；改过 token 后旧配置立即失效 |
| `404` | 路径不是 `/mcp` | 只暴露一个端点，带不带尾斜杠都认 |
| **握手成功但 `toolCount: 0`** | **App 版本早于 `c59f8c8c`**：`tools/list` 在注册之前读表，读到空表（详见下节） | 更新 App |
| `工具没注册` | 档位没开 | 该工具属于未开启的档位，`tools/list` 不会列出它 |
| `isError: 档位未开启` | 工具调用了但档位关着 | 打开对应档位，或在弹窗里确认 |
| 写入返回预览 | 正常，两步确认 | 带 `confirm: true` 重发 |

### 「握手成功但 0 个工具」这个坑（已修，`c59f8c8c`）

真机实测（2026-10-21）：握手成功、Bearer 通过、只读档已开，但 `tools/list`
返回 **0 个工具**，连 `list_workspace_files` 都被判「不在暴露清单里」。

根因是个自锁死循环：

```
tools/list → 读注册表（空）→ 返回 0 个工具
     ↓
agent 不知道有哪些工具 → 不发起任何 tools/call
     ↓
executeMcpTool（唯一调用 registerDefaultWorkspaceTools 的地方）永远不执行
     ↓
注册表永远是空的
```

修法：`listToolDefinitions` 改为 async，**先注册（幂等）再读表**；
`serverBridge` 的 `catalog()` 改为 async 并 await。
修复后实测 16 个工具正常列出。

**这个修复在 JS 层，必须重新打包安装才生效**——光拉代码不够。


## 七、已知边界

- **只有 Android**：没有 iOS 原生实现（`serverBridge.js:52`）。
- **无 SSE 推送**：`GET /mcp` 返回 405，只支持 POST JSON-RPC。
- **请求串行**：同一时刻只处理一个 MCP 请求（工具会动同一个工作区，并发只有竞态）。
- **HTTP 超时 360 秒**：大于工具层最长超时（子代理 300s），所以工具还在跑时 HTTP 不会先断。
- **App 退到后台**：只要进程还活着就继续应答（这是与本地 API 服务刻意不同的地方）。
