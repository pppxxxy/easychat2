// H1：云构建桥（给 agent 工具用的 IO 层）——把「触发 workflow / 读构建日志」
// 包成 tools 可注入的 options.ci。token 从 githubMcp 存储**惰性取**
//（静态 import 会把 AsyncStorage 拖进纯 Node 测试的工具模块图——与 subagent.js
// 的 require 惰性同款）。
//
// 语义与面板入口一致：触发 = workflow_dispatch（远端副作用，确认门在 registry 层
// 的 requiresConfirmation）；读日志 = 最近一次 run 的 zip 解包文本。

import { dispatchWorkflow, downloadRunLogs, listWorkflowRuns } from './github/restApi.js';

export async function resolveGithubToken() {
  try {
    const mod = require('../storage/githubMcp.js');
    const settings = await mod.getGithubMcpSettings();
    if (!settings || settings.enabled !== true) return '';
    return settings.authMethod === 'oauth'
      ? String(settings.githubAccessToken || '')
      : String(settings.githubToken || '');
  } catch (error) {
    return '';
  }
}

export const ciBridge = {
  async dispatch({ owner, repo, workflow, ref = '' } = {}) {
    const token = await resolveGithubToken();
    if (!token) return { ok: false, error: 'no-token' };
    await dispatchWorkflow({ token, owner, repo, workflow, ref });
    return { ok: true };
  },

  // 最近一次构建（可按 workflow 过滤）的状态 + 日志（头尾截断在 restApi 层做）。
  async latestLog({ owner, repo, workflow = '', branch = '' } = {}) {
    const token = await resolveGithubToken();
    if (!token) return { ok: false, error: 'no-token' };
    const runs = await listWorkflowRuns({
      token,
      owner,
      repo,
      ...(workflow ? { workflow } : {}),
      ...(branch ? { branch } : {}),
      perPage: 5,
    });
    if (runs.length === 0) return { ok: true, run: null, text: '' };
    const run = runs[0];
    let text = '';
    try {
      const logs = await downloadRunLogs({ token, owner, repo, runId: run.id, limit: 32 * 1024 });
      text = logs.text;
    } catch (error) {
      text = '';
    }
    return { ok: true, run, text };
  },
};
