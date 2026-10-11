// 内置 MCP Server 桥（从 App.js 原样外提，行为零变化）：接原生事件（有请求就交给协议层
// 应答）+ 按设置启停。
//
// 为什么外提：App.js 越过 800 行上限后，按行数基线口径「先外提」而不是抬高数字；
// 这两个桥自包含、与 App.js 其余部分零交叉，AGENTS.md 也点名启动期桥放 src/startup/。
//
// 与 localApiServerBridge.js 的**关键差别**：这里**不监听 AppState**。本地 API 服务是给
// 本机自己用的（退后台就该停，省端口省电）；MCP 是给另一台设备上的 agent 用的，
// 一退后台就断会让人以为坏了。进程被 Android 杀掉才会断，那时原生 invalidate() 会收尾。

import { useEffect } from 'react';

import { isMcpServerAvailable, stopMcpServer } from '../mcp/serverBridge.js';
import { attachRuntimeMcpServer, syncMcpServer } from '../mcp/serverRuntime.js';

export default function McpServerBridge() {
  useEffect(() => {
    if (!isMcpServerAvailable()) return undefined;
    const detach = attachRuntimeMcpServer();
    syncMcpServer().catch(() => {});
    return () => {
      detach();
      stopMcpServer().catch(() => {});
    };
  }, []);
  return null;
}
