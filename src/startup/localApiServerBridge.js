// 本地 API 服务桥（从 App.js 原样外提，行为零变化）：把原生 HTTP 请求接到常驻本地模型，
// 退后台/卸载时停服释放端口。
//
// 为什么外提：App.js 是根装配层，超级合并后越过 800 行上限（新增 MCP 服务桥等启动接线）。
// 行数基线的口径是「能外提就外提，不靠抬高数字凑数」，而这两个桥是自包含的 useEffect
// 组件、与 App.js 其余部分零交叉——正好落在 AGENTS.md 点名的「启动期组件/桥放 src/startup/」。
//
// 与 mcpServerBridge.js 的**关键差别**：本桥监听 AppState，退后台即停服——本地 API 服务
// 是给本机自己用的（省端口省电）；MCP 是给另一台设备上的 agent 用的，退后台就断会让人
// 以为坏了，所以那边不停（见该文件的注释）。

import { useEffect } from 'react';
import { AppState } from 'react-native';

import { runLocalModel } from '../localModel/adapter.js';
import {
  attachLocalApiServerAgent,
  attachLocalApiServerInference,
  isLocalApiServerAvailable,
  stopLocalApiServer,
} from '../localModel/localApiServer.js';
import { getActiveLocalModel } from '../storage/localModels.js';
import { tryAcquireResource } from '../utils/resourceMutex.js';
import { runHeadlessAgent } from '../workspace/headlessAgent.js';

export default function LocalApiServerBridge() {
  useEffect(() => {
    if (!isLocalApiServerAvailable()) return undefined;
    const unsubscribe = attachLocalApiServerInference({
      runInference: async (messages, model, options = {}) => {
        const item = await getActiveLocalModel().catch(() => null);
        if (!item) throw new Error('No local model selected');
        const release = tryAcquireResource('local-model');
        if (!release) throw new Error('Local model is busy');
        try {
          // OpenAI 语义是无状态：每个请求用独立会话标识，跨请求必清 KV cache，
          // 避免上一个客户端请求的内容串进下一个请求。
          const result = await runLocalModel(messages, item, {
            conversationKey: `api-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            // v5 Stage D：把流式 token 透传给 API 服务器桥（stream=true 时逐片回写 SSE）。
            onToken: typeof options.onToken === 'function' ? options.onToken : undefined,
          });
          return result && typeof result.text === 'string' ? result.text : '';
        } finally {
          release();
        }
      },
    });
    // P3-8：POST /v1/agent —— 程序化驱动一轮 agent 工具循环（复用工作区组装：沙盒 + 系统提示 + 工具）。
    const unsubscribeAgent = attachLocalApiServerAgent({ runAgent: runHeadlessAgent });
    let previous = AppState.currentState;
    const subscription = AppState.addEventListener('change', next => {
      if (previous === 'active' && next !== 'active') {
        stopLocalApiServer().catch(() => {});
      }
      previous = next;
    });
    return () => {
      unsubscribe();
      unsubscribeAgent();
      subscription.remove();
      stopLocalApiServer().catch(() => {});
    };
  }, []);
  return null;
}
