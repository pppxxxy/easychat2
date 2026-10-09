// MCP 域共享常量（**零依赖**，任何模块都可安全静态 import）。
//
// 抽出来的原因：内置 GitHub 的 id / 工具名前缀 / 默认端点曾在三个模块各定义一份
// （mcpTools.js 的 BUILTIN_GITHUB_ID、storage/settings/mcpServers.js 的 GITHUB_SERVER_ID、
// mcp/client.js 的 DEFAULT_GITHUB_MCP_ENDPOINT），靠注释同步「两处必须一致」。
// 一旦漂移，表现是保留字保护失效（安全）或工具前缀对不上（功能），都难查。
// 常量不该靠纪律同步，靠 import——本文件零依赖，不存在「为了躲 storage 静态依赖
// 而重复定义」的动机（那正是当初分头定义的原因）。

export const GITHUB_SERVER_ID = 'github';
// 内置 GitHub 的工具前缀：保持 `github_`（兼容既有工具名与用户认知）；
// 第三方服务器用 `<id>__` 命名空间（见 mcpTools.mcpToolPrefix）。
export const GITHUB_TOOL_PREFIX = 'github_';
export const DEFAULT_GITHUB_MCP_ENDPOINT = 'https://api.githubcopilot.com/mcp/';
