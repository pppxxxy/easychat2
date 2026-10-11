// 工作区 agent 的工具装配（W7 从 ChatPanel 外提）。
//
// 两件事必须一起做，因为它们的**顺序是契约**：
//  1) 注册工具——提示词里要不要写「可以跑 Python / 可以执行命令」，判据必须是「注册表里
//     真的有」（开关开着但原生模块缺失、或根是外部文件夹时并不存在），所以注册必须先于拼提示词；
//  2) 冻结工具顺序签名——tools 定义计入前缀缓存键，同一 mode 下序列漂移 = 缓存全 miss。
//
// 外提的另一个理由：这段原本长在 1851 行、顶格零余量的 ChatPanel 里，而「顺序漂移」
// 这条前缀缓存纪律当时只能靠源码字符串断言——现在它是可直测的返回值。

import { listToolsForMode } from '../agent/tools/registry.js';
import { registerDefaultWorkspaceTools } from './native.js';
import { ensureMcpToolsRegistered } from './mcpTools.js';
import { toolOrderSignature } from './chat.js';

// register / registerMcp 都可注入（测试用假注册表；生产走真实实现）。
//
// 2026-10-11（用户裁决）：**工作区 agent 也挂 MCP 工具**（含内置 GitHub）。此前只有角色聊天挂，
// 结果是工作区的「让助手推送」让模型去用根本不存在的 GitHub 工具。安全面不变——仍由
// riskGate 决定注册哪些（删除/强推/管理类**全局硬禁止**）、写入类逐条确认（与角色聊天同一套）。
// 注册失败不影响文件工具（MCP 是增强，不是依赖）。
export async function registerWorkspaceAgentTools({
  settings,
  mode,
  readLog = null,
  materializer = null,
  onPlan = null,
  previous = {},
  register = registerDefaultWorkspaceTools,
  registerMcp = ensureMcpToolsRegistered,
} = {}) {
  // ask 模式没有工具：不注册、不签名（与旧行为逐字一致）。
  if (mode === 'ask') return { tools: [], signature: '', prevSignature: '', drifted: false };
  register(settings, {
    readLog,
    materializer: typeof materializer === 'function' ? materializer : null,
    // W3②：计划随会话落盘（宿主注入；不注入 = 不落盘，与旧行为一致）。
    onPlan: typeof onPlan === 'function' ? onPlan : null,
  });
  if (typeof registerMcp === 'function') {
    try {
      await registerMcp();
    } catch (error) {
      // MCP 挂了也要有文件工具可用。
    }
  }
  const tools = listToolsForMode(mode);
  const signature = toolOrderSignature(tools);
  const prevSignature = String((previous && previous[mode]) || '');
  return { tools, signature, prevSignature, drifted: Boolean(prevSignature && prevSignature !== signature) };
}
