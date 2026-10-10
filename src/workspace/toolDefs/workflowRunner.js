// 工作流步骤执行器（run_workflow 与 run_team 共用）。
//
// 抽出来解决两件事：
// 1. **agent 字段此前被忽略**：workflow.js 的 normalizeWorkflowSteps 早就接受 `agent`，
//    但执行器没读它——写了 agent 也按默认分身跑。这里按 step.agent 取 .easychat/agents
//    档案，收窄工具集与轮次（与 run_subagent 的 agent 参数同款语义）。
// 2. **黑板共享**：整批步骤共享一块黑板（团队通信，见 agent/blackboard.js），署名 step.id。
//
// 只读/写工具来源从 readTools/writeTools 直接引（不经注册表），防递归名单天然不含 run_subagent。

import { runSubagent, SUBAGENT_TOOL_NAMES, SUBAGENT_WRITE_TOOL_NAMES } from '../../agent/subagent.js';
import { runWorkflow } from '../../agent/workflow.js';
import { createBlackboard } from '../../agent/blackboard.js';
import { readWorkspaceAgents } from '../agents.js';
import { READ_ONLY_TOOL_DEFINITIONS } from './readTools.js';
import { WRITE_TOOL_DEFINITIONS } from './writeTools.js';
import { BOARD_TOOL_DEFINITIONS } from './boardTools.js';

const READ_TOOLS = READ_ONLY_TOOL_DEFINITIONS.filter(item => SUBAGENT_TOOL_NAMES.includes(item.name));
const WRITE_TOOLS = WRITE_TOOL_DEFINITIONS.filter(item => SUBAGENT_WRITE_TOOL_NAMES.includes(item.name));

// 跑一组步骤：共享黑板 + 逐步骤按 agent 档案收窄工具/轮次。返回 runWorkflow 的结果。
// stream 仅测试注入（生产走 runSubagent 的默认取配置路径）。
export async function runWorkflowSteps({ store, characterId, signal, confirm, steps, onStep, stream = null } = {}) {
  const board = createBlackboard();
  return runWorkflow({
    steps,
    signal,
    onStep,
    runStep: async step => {
      const writeMode = step.mode === 'write';
      let tools = writeMode ? READ_TOOLS.concat(WRITE_TOOLS) : READ_TOOLS;
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
        board,
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
