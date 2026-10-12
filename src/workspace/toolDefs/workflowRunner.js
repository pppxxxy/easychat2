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
      // 请求了 write 却拿不到授权 → **这一步判失败**，不静默降级成只读跑一遍。
      // 静默降级会让编排层拿到一份「跑过了」的结论（模型以为改动落地了），
      // 那正是「没写的写成了」的另一种伪装。run_workflow 工具层已在入口整体拒绝
      // 这种情况；这里是纵深防御（run_team 等其它入口直接调本函数）。
      if (step.mode === 'write' && !allowWrite) {
        // 文案**有意不统一**到 toolNotices.js 的 MODE_SWITCH_HINT：这里形状不同
        //（只陈述「模式不对 + 没执行」，不含给用户的操作指示），而且它是**步骤级**
        // 错误——上抛后由 run_workflow 工具层自己的整条拒绝文案负责把「请切模式」
        // 讲清楚。硬凑成一句会让步骤级错误变成半截用户指示，且会改动模型读到的字
        //（本字符串会经 formatWorkflowResult 进工具结果）。见 toolNotices.js 文件头。
        return { text: '', isError: true, error: '当前不是「可改」模式，write 步骤未执行' };
      }
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
        // P1（2026-10-11）：**必须把宿主模式一路传下去**。runSubagent 内部按
        // `mode === 'write' && workspaceMode !== 'write'` 拒绝写子代理（纵深防御第二层）。
        // 此前这里漏传 → 每一个 write 步骤都恒返回「写子代理不可用：当前不是「可改」模式
        // （未执行）」，而 runWorkflow 仍 ok:true、formatWorkflowResult 照报成功 ——
        // 「没写的写成了」被伪装成完成。写授权只看宿主模式，与上面的 writeMode 同源。
        workspaceMode: writeMode ? 'write' : 'read',
        confirm,
        board: sharedBoard,
        extraTools: BOARD_TOOL_DEFINITIONS,
        agentName: step.id || profileName || 'step',
        ...(stream ? { stream } : {}),
        ...(maxRounds ? { maxRounds } : {}),
      });
      // 失败要**如实上抛**（见 agent/workflow.js 的 runStep 契约）：内容仍带上，
      // 但标记 isError 让编排层把整个工作流判为失败，而不是合并出一段看起来成功的结论。
      const content = (outcome && outcome.content) || '';
      if (outcome && outcome.isError === true) {
        return { text: content, isError: true, error: content || '（无错误说明）' };
      }
      // write 步骤里只要有工具调用失败，这一步就**没做成**（写被拒 / 问不到用户 /
      // 路径被守卫拦下）。子代理照样会产出一段结论文字，只看文字就会把「没写的」
      // 报成「工作流成功」——P1 事故正是这种形态。
      const toolErrors = Number(outcome && outcome.toolErrors) || 0;
      if (writeMode && toolErrors > 0) {
        return {
          text: content,
          isError: true,
          error: `${toolErrors} 次写操作未成功（被拒绝或未获批准）`,
        };
      }
      return { text: content, isError: false };
    },
  });
}

// 把 runWorkflow 的结果格式化成工具返回对象（错误 / 按拓扑顺序合并的结论）。
//
// 失败时：**明确报错**（isError: true）并点名失败的步骤，而不是把子代理那段
// 「不可用/未执行」的文字当结论合并出来（那正是「没写的写成了」的伪装）。
// 已成功步骤的结论仍附在错误文案之后——部分信息比空手好，但成功/失败的判定必须诚实。
export function formatWorkflowResult(result) {
  if (!result || !result.ok) {
    const errors = (result && result.errors) || ['未知错误'];
    const failed = Array.isArray(result && result.failed) ? result.failed : [];
    const done = result && result.order
      ? result.order.filter(id => !failed.includes(id))
      : [];
    const succeeded = done
      .map(id => `【步骤 ${id}】${String((result.results || {})[id] || '').trim()}`)
      .filter(text => text.replace(/【步骤 [^】]*】/, '').trim())
      .join('\n\n');
    const head = failed.length > 0
      ? `工作流未完成（有步骤执行失败）：${errors.join('；')}`
      : `工作流无法执行：${errors.join('；')}`;
    return {
      content: succeeded ? `${head}\n\n（以下是已成功步骤的结论，供参考）\n${succeeded}` : head,
      isError: true,
    };
  }
  const merged = result.order
    .map(id => `【步骤 ${id}】${String(result.results[id] || '').trim()}`)
    .join('\n\n');
  return { content: merged || '工作流没有产出结论。' };
}
