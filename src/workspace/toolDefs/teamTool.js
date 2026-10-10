// 团队工具定义（run_team）——按名字运行一个保存好的工作区团队（.easychat/teams/<name>.md）。
//
// 团队 = 保存好的工作流（见 workspace/teams.js）：run_team 读团队文件里的步骤，
// 交给 workflowRunner 执行（agent 档案收窄 + 共享黑板），与 run_workflow 同一条执行路径。

import { readWorkspaceTeams } from '../teams.js';
import { loadPersistentBlackboard, savePersistentBlackboard } from '../boardStore.js';
import { runWorkflowSteps, formatWorkflowResult } from './workflowRunner.js';

export const RUN_TEAM_TOOL_DEFINITION = {
  name: 'run_team',
  description: '按名字运行一个保存好的工作区团队（.easychat/teams/<name>.md 里定义的多步'
    + '子代理编排）。团队清单见系统提示的「工作区团队」段。可用 objective 给本次运行'
    + '补充目标/主题——团队步骤可以写通用描述，运行时再用 objective 指定具体对象。'
    + '默认 remember=true：团队的共享黑板会跨会话沉淀（下次运行先读上次的结论），'
    + '想从空白开始就传 remember=false。',
  readOnly: true,
  // 与 run_workflow 同量级：多步 × 多轮模型请求。
  timeoutMs: 600000,
  parameters: {
    type: 'object',
    properties: {
      team: { type: 'string', description: '团队名（见系统提示的「工作区团队」清单）。' },
      objective: { type: 'string', description: '可选：本次运行的目标/主题，追加到每一步的子任务。' },
      remember: { type: 'boolean', description: '可选：默认 true——共享黑板跨会话沉淀；false 则本次从空白开始。' },
    },
    required: ['team'],
  },
  execute: async (options, args, ctx) => {
    const name = String((args && args.team) || '').trim();
    if (!name) return { content: 'run_team 需要 team。', isError: true };
    const teams = await readWorkspaceTeams(options.store, ctx && ctx.characterId, [name]).catch(() => []);
    const team = (Array.isArray(teams) ? teams : []).find(item => (
      item && (String(item.name || '') === name || String(item.dirName || '') === name)
    ));
    if (!team) {
      return { content: `没有名为「${name}」的团队（用 list_workspace_files 看 .easychat/teams/ 下的文件）。`, isError: true };
    }
    if (!Array.isArray(team.steps) || team.steps.length === 0) {
      return { content: `团队「${name}」没有定义步骤。`, isError: true };
    }
    const objective = String((args && args.objective) || '').trim();
    const steps = objective
      ? team.steps.map(step => ({ ...step, task: `${step.task}\n\n（本次团队目标：${objective}）` }))
      : team.steps;
    // 跨会话：默认播种此前沉淀的黑板，跑完再落盘（空黑板不覆盖已有文件）。
    const remember = !(args && args.remember === false);
    const board = remember ? await loadPersistentBlackboard(options.store, ctx && ctx.characterId) : undefined;
    const result = await runWorkflowSteps({
      store: options.store,
      characterId: ctx && ctx.characterId,
      signal: (ctx && ctx.signal) || null,
      confirm: (ctx && typeof ctx.confirm === 'function') ? ctx.confirm : null,
      steps,
      ...(board ? { board } : {}),
    });
    if (board) await savePersistentBlackboard(options.store, ctx && ctx.characterId, board).catch(() => {});
    return formatWorkflowResult(result);
  },
};

