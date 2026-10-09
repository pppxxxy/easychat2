// H1：云构建工具定义（run_remote_build / get_build_log）。
//
// 定位（外部调研 L2 的落地）：手机跑不动 LSP/构建工具链——把「写 → 检查 → 修」
// 闭环的重活交给 GitHub Actions，agent 只做触发与读日志。与面板入口（工具栏
// 「触发云构建」）共用同一份 restApi。
//
// 门控：run_remote_build 有远端副作用 → readOnly:false + requiresConfirmation
//（走通用审批链 toolApprovalFlow）；get_build_log 纯读 → readOnly:true（read 模式
// 也可用——看构建日志不需要改文件的权限）。

// 纯函数：把 'owner/repo' 解析成 { owner, repo }（坏输入 → null）。
export function parseRepoArg(text) {
  const match = String(text || '').trim().match(/^([^/\s]+)\/([^/\s]+)$/);
  return match ? { owner: match[1], repo: match[2] } : null;
}

// 仓库解析：显式参数优先（'owner/repo'）；缺省扫工作区 repos/ 前缀——
// 恰好一个仓库时自动用它；多个/零个返回 null（调用方提示模型指定）。
export async function resolveRepoArg(options, characterId, explicit) {
  const direct = parseRepoArg(explicit);
  if (direct) return direct;
  if (String(explicit || '').trim()) return null; // 给了但格式不对 → 不当成缺省
  try {
    const files = await options.store.listWorkspaceFiles({ characterId });
    const found = new Set();
    for (const entry of Array.isArray(files) ? files : []) {
      const match = String(entry).match(/^repos\/([^/]+)\/([^/]+)\//);
      if (match) found.add(`${match[1]}/${match[2]}`);
    }
    if (found.size === 1) return parseRepoArg([...found][0]);
  } catch (error) {}
  return null;
}

const REPO_HINT = '工作区里有多个（或没有）仓库副本——请在参数里写明 repo（owner/repo 形态）。';

export const RUN_REMOTE_BUILD_DEFINITION = {
  name: 'run_remote_build',
  description: '在 GitHub Actions 上触发一次构建（workflow_dispatch）：构建 / 跑测试 / '
    + '静态检查这类重活跑在 GitHub 的机器上，不占手机。适合改完代码后验证改动。'
    + '每次触发都会先请用户确认。触发后用 get_build_log 读构建状态与日志。'
    + 'repo 可写 owner/repo（工作区只有一个仓库副本时可省略）。',
  readOnly: false,
  requiresConfirmation: true,
  // 触发是一次网络写请求 + 用户确认等待，超时给宽一点。
  timeoutMs: 60000,
  parameters: {
    type: 'object',
    properties: {
      workflow: { type: 'string', description: 'workflow 文件名（.github/workflows/ 下，如 ci.yml）。' },
      ref: { type: 'string', description: '分支名（缺省用仓库默认分支）。' },
      repo: { type: 'string', description: 'owner/repo（可选，工作区只有一个仓库副本时可省略）。' },
    },
    required: ['workflow'],
  },
  execute: async (options, args, ctx) => {
    if (!options.ci) return { content: '云构建不可用（当前会话未接入 GitHub 通道）。', isError: true };
    const target = await resolveRepoArg(options, ctx && ctx.characterId, args && args.repo);
    if (!target) return { content: REPO_HINT, isError: true };
    const result = await options.ci.dispatch({
      owner: target.owner,
      repo: target.repo,
      workflow: args && args.workflow,
      ref: (args && args.ref) || '',
    });
    if (!result.ok) {
      return {
        content: result.error === 'no-token'
          ? '云构建不可用：还没有配置 GitHub 凭据（在 GitHub 工作台绑定 token 后重试）。'
          : '云构建触发失败。',
        isError: true,
      };
    }
    return '已触发构建（workflow_dispatch）。构建需要一些时间：稍后用 get_build_log 读最近一次的状态与日志。';
  },
};

export const GET_BUILD_LOG_DEFINITION = {
  name: 'get_build_log',
  description: '读取最近一次云构建的状态与日志（GitHub Actions）。用它看构建/测试/检查的'
    + '报错，然后据此修复代码。日志过大时会头尾截断（报错通常在尾部，不会被切掉）。'
    + 'repo 可写 owner/repo（工作区只有一个仓库副本时可省略）。',
  readOnly: true,
  timeoutMs: 90000,
  parameters: {
    type: 'object',
    properties: {
      workflow: { type: 'string', description: '只看该 workflow 的构建（可选）。' },
      branch: { type: 'string', description: '只看该分支的构建（可选）。' },
      repo: { type: 'string', description: 'owner/repo（可选，工作区只有一个仓库副本时可省略）。' },
    },
    required: [],
  },
  execute: async (options, args, ctx) => {
    if (!options.ci) return { content: '云构建不可用（当前会话未接入 GitHub 通道）。', isError: true };
    const target = await resolveRepoArg(options, ctx && ctx.characterId, args && args.repo);
    if (!target) return { content: REPO_HINT, isError: true };
    const result = await options.ci.latestLog({
      owner: target.owner,
      repo: target.repo,
      workflow: (args && args.workflow) || '',
      branch: (args && args.branch) || '',
    });
    if (!result.ok) {
      return {
        content: result.error === 'no-token'
          ? '云构建不可用：还没有配置 GitHub 凭据（在 GitHub 工作台绑定 token 后重试）。'
          : '读取构建日志失败。',
        isError: true,
      };
    }
    if (!result.run) return '最近没有构建记录。可以先用 run_remote_build 触发一次。';
    const run = result.run;
    const head = `构建 #${run.id}（${run.displayTitle || run.name}）：${run.status === 'completed' ? (run.conclusion || 'done') : run.status} · 分支 ${run.branch || '-'} · ${run.sha || ''}`;
    if (!result.text) return `${head}\n（暂时没有日志——可能还在排队，稍后再读一次。）`;
    return `${head}\n\n${result.text}`;
  },
};
