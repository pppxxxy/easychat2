// H1 云构建（GitHub Actions）的编排：触发 workflow_dispatch + 最近构建列表 + 日志查看。
// 从 screen/GithubPanel.js 原样外提（无行为变化）：手动刷新、不自动轮询（手机端省电也省限流）。
// 展示层在 github/BuildSection.js。

import { useCallback, useState } from 'react';
import { Alert } from 'react-native';

import { dispatchWorkflow, downloadRunLogs, listWorkflowRuns } from '../../github/restApi.js';

export default function useGithubBuild({ current, token, pullBranch, describeError, mountedRef, t }) {
  const [buildWorkflow, setBuildWorkflow] = useState('');
  const [buildBusy, setBuildBusy] = useState(false);
  const [buildRuns, setBuildRuns] = useState([]);
  const [buildLog, setBuildLog] = useState(null);
  const [buildNotice, setBuildNotice] = useState('');

  // H1：刷新最近构建（手动——不自动轮询，省电也省限流额度）。定义在 submitBuild 前
  //（后者依赖前者：useCallback 的 deps 在定义时求值，顺序反了会踩 TDZ）。
  const refreshBuildRuns = useCallback(async () => {
    if (!current) return;
    try {
      const workflow = String(buildWorkflow || '').trim();
      const runs = await listWorkflowRuns({
        token,
        owner: current.owner,
        repo: current.repo,
        ...(workflow ? { workflow } : {}),
        branch: String(pullBranch || current.branch || '').trim(),
        perPage: 10,
      });
      if (mountedRef.current) setBuildRuns(runs);
    } catch (caught) {
      if (mountedRef.current) Alert.alert(t('workspace.github.title'), describeError(caught));
    }
  }, [buildWorkflow, current, describeError, pullBranch, t, token]);

  // H1：触发云构建（workflow_dispatch——远端副作用，按钮文案即确认语义）。
  const submitBuild = useCallback(async () => {
    if (!current || buildBusy) return;
    const workflow = String(buildWorkflow || '').trim();
    if (!workflow) {
      Alert.alert(t('workspace.github.title'), t('workspace.github.build.needWorkflow'));
      return;
    }
    setBuildBusy(true);
    setBuildNotice('');
    try {
      await dispatchWorkflow({
        token,
        owner: current.owner,
        repo: current.repo,
        workflow,
        ref: String(pullBranch || current.branch || '').trim(),
      });
      if (mountedRef.current) setBuildNotice(t('workspace.github.build.dispatched'));
      await refreshBuildRuns();
    } catch (caught) {
      Alert.alert(t('workspace.github.title'), describeError(caught));
    } finally {
      if (mountedRef.current) setBuildBusy(false);
    }
  }, [buildBusy, buildWorkflow, current, describeError, pullBranch, refreshBuildRuns, t, token]);

  // H1：看某次构建的日志（zip 解包在 restApi 里做，这里只展示——头尾截断已在拉取层）。
  const openBuildLog = useCallback(async runId => {
    if (!current) return;
    setBuildLog({ runId, text: t('workspace.github.build.logLoading'), loading: true });
    try {
      const result = await downloadRunLogs({
        token,
        owner: current.owner,
        repo: current.repo,
        runId,
      });
      if (mountedRef.current) {
        setBuildLog({ runId, text: result.text || t('workspace.github.build.logEmpty'), loading: false });
      }
    } catch (caught) {
      if (mountedRef.current) {
        setBuildLog({ runId, text: describeError(caught), loading: false });
      }
    }
  }, [current, describeError, t, token]);

  return {
    buildWorkflow,
    setBuildWorkflow,
    buildBusy,
    buildRuns,
    buildLog,
    setBuildLog,
    buildNotice,
    refreshBuildRuns,
    submitBuild,
    openBuildLog,
  };
}
