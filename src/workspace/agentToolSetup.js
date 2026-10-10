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
import { toolOrderSignature } from './chat.js';

// register 可注入（测试用假注册表；生产走 registerDefaultWorkspaceTools）。
export function registerWorkspaceAgentTools({
  settings,
  mode,
  readLog = null,
  materializer = null,
  previous = {},
  register = registerDefaultWorkspaceTools,
} = {}) {
  // ask 模式没有工具：不注册、不签名（与旧行为逐字一致）。
  if (mode === 'ask') return { tools: [], signature: '', prevSignature: '', drifted: false };
  register(settings, {
    readLog,
    materializer: typeof materializer === 'function' ? materializer : null,
  });
  const tools = listToolsForMode(mode);
  const signature = toolOrderSignature(tools);
  const prevSignature = String((previous && previous[mode]) || '');
  return { tools, signature, prevSignature, drifted: Boolean(prevSignature && prevSignature !== signature) };
}
