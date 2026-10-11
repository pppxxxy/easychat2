// 工作流步骤执行器（run_workflow 与 run_team 共用）。
//
// 抽出来解决两件事：
// 1. **agent 字段此前被忽略**：workflow.js 的 normalizeWorkflowSteps 早就接受 `agent`，
//    但执行器没读它——写了 agent 也按默认分身跑。这里按 step.agent 取 .easychat/agents
//    档案，收窄工具集与轮次（与 run_subagent 的 agent 参数同款语义）。
// 2. **黑板共享**：整批步骤共享一块黑板（团队通信，见 agent/blackboard.js），署名 step.id。
//
// F1/F3 + P0-2（Z/D 两线整合）：工具表走共用装配点 subagentTools（此前这里各写一份白名单，
// 漏了 search_workspace）；写授权只看**宿主模式** hostMode，不看步骤里模型传的 mode。

import { runSubagent } from '../../agent/subagent.js';
import { runWorkflow } from '../../agent/workflow.js';
import { createBlackboard } from '../../agent/blackboard.js';
import { readWorkspaceAgents } from '../agents.js';
import { buildSubagentTools } from './subagentTools.js';
import { BOARD_TOOL_DEFINITIONS } from './boardTools.js';

// 跑一组步骤：共享黑板 + 逐步骤按 agent 档案收窄工具/轮次。返回 runWorkflow 的结果。
// board 由调用方注入（跨会话时传入持久化播种的黑板；不传则新建一块内存黑板）。
// stream 仅测试注入（生产走 runSubagent 的默认取配置路径）。
// hostMode 是宿主当前模式（registry 的 ctx.mode）：write 步骤只有在宿主本身可写时才放行。
export async function runWorkflowSteps({
  store, characterId, signal, confirm, steps, onStep, stream = null, board, hostMode = null, buildTools = buildSubagentTools,
} = {}) {
  const sharedBoard = board || createBlackboard();
  // 缺省（未给 hostMode）= 不放行写（fail-closed）。
  const allowWrite = String(hostMode == null ? '' : hostMode).toLowerCase() === 'write';
  return runWorkflow({
    steps,
    signal,
    onStep,
    runStep: async step => {
      // 宿主模式才是授权；步骤 mode='write' 只是「请求」。
      const writeMode = step.mode === 'write' && allowWrite;
      let tools = buildTools(writeMode ? 'write' : 'read');
      let maxRounds;
      const profileName = String(step.agent || '').trim();
      if (profileName) {
        try {
          const profiles = await readWorkspaceAgents(store, characterId, [profileName]);
          const profile = profiles[0];
          if (profile) {
            if (Array.isArray(profile.tools) && profile.tools.length > 0) {
              tools = tools.filter(item => profile.tools.includes(item.name));
            }
            if (Number.isFinite(profile.maxRounds)) maxRounds = profile.maxRounds;
          }
        } catch (error) {
          // 档案读失败按默认分身继续——研究任务不该因档案问题不可用。
        }
      }
      const outcome = await runSubagent({
        task: step.task,
        tools: tools.concat(BOARD_TOOL_DEFINITIONS),
        store,
        characterId,
        signal,
        mode: writeMode ? 'write' : 'read',
        confirm,
        board: sharedBoard,
        extraTools: BOARD_TOOL_DEFINITIONS,
        agentName: step.id || profileName || 'step',
        ...(stream ? { stream } : {}),
        ...(maxRounds ? { maxRounds } : {}),
      });
      return outcome && outcome.content ? outcome.content : '';
    },
  });
}

// 把 runWorkflow 的结果格式化成工具返回对象（错误 / 按拓扑顺序合并的结论）。
export function formatWorkflowResult(result) {
  if (!result || !result.ok) {
    const errors = (result && result.errors) || ['未知错误'];
    return { content: `工作流无法执行：${errors.join('；')}`, isError: true };
  }
  const merged = result.order
    .map(id => `【步骤 ${id}】${String(result.results[id] || '').trim()}`)
    .join('\n\n');
  return { content: merged || '工作流没有产出结论。' };
}
