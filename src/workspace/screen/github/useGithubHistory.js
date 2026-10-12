// E5 提交历史（内联展开 + 翻页 + 单提交 diff）与 PR 创建的状态与动作。
// 从 screen/GithubPanel.js 原样外提（无行为变化）：失败不弹窗（非阻塞区块），行内给错误行重试。
// PR 是写操作——本地确认门说清 head → base，再由 restApi 发请求。

import { useCallback, useState } from 'react';
import { Alert } from 'react-native';

import { createPullRequest, getCommitDiff, listCommits, truncateDiffText } from '../../github/restApi.js';

export default function useGithubHistory({ current, token, pullBranch, describeError, mountedRef, t }) {
  // E5：提交历史（内联展开 + 翻页）与单提交 diff；PR 创建进行中。
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyCommits, setHistoryCommits] = useState([]);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyError, setHistoryError] = useState(false);
  const [historyDiff, setHistoryDiff] = useState(null);
  const [prBusy, setPrBusy] = useState(false);

  // E5：提交历史（内联展开）——首屏 30 条、可翻页；点条目看截断后的 diff。
  // 失败不弹窗（非阻塞区块），行内给错误行重试即可。
  const loadHistory = useCallback(async (page = 1, append = false) => {
    if (!current || historyBusy) return;
    setHistoryBusy(true);
    setHistoryError(false);
    try {
      const branchName = String(current.branch || pullBranch || '').trim();
      const commits = await listCommits({
        token,
        owner: current.owner,
        repo: current.repo,
        ...(branchName ? { branch: branchName } : {}),
        page,
      });
      if (!mountedRef.current) return;
      setHistoryCommits(list => (append ? [...list, ...commits] : commits));
      setHistoryPage(page);
    } catch (caught) {
      if (mountedRef.current) setHistoryError(true);
    } finally {
      if (mountedRef.current) setHistoryBusy(false);
    }
  }, [current, historyBusy, pullBranch, token]);

  const openCommitDiff = useCallback(async sha => {
    if (!current || !sha) return;
    setHistoryDiff({ sha, text: t('workspace.github.history.diffLoading'), loading: true });
    try {
      const raw = await getCommitDiff({ token, owner: current.owner, repo: current.repo, sha });
      const { text } = truncateDiffText(raw);
      if (mountedRef.current) {
        setHistoryDiff({ sha, text: text || t('workspace.github.history.diffEmpty'), loading: false });
      }
    } catch (caught) {
      if (mountedRef.current) {
        setHistoryDiff({ sha, text: t('workspace.github.history.diffError'), loading: false });
      }
    }
  }, [current, t, token]);

  // E5：创建 PR（写操作）——本地确认门说清 head → base，再由 restApi 发请求；
  // 失败按错误码映射给清晰文案（无权限 / 分支不存在 / 冲突）。
  const submitCreatePr = useCallback(() => {
    if (!current || prBusy) return;
    const head = String(pullBranch || current.branch || '').trim();
    const base = String(current.defaultBranch || 'main').trim();
    if (!head || head === base) {
      Alert.alert(t('workspace.github.title'), t('workspace.github.pr.badBranches', { base }));
      return;
    }
    Alert.alert(
      t('workspace.github.pr.confirmTitle'),
      t('workspace.github.pr.confirmBody', { head, base, name: `${current.owner}/${current.repo}` }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('workspace.github.pr.confirmAction'),
          onPress: async () => {
            setPrBusy(true);
            try {
              const pr = await createPullRequest({
                token,
                owner: current.owner,
                repo: current.repo,
                title: t('workspace.github.pr.defaultTitle', { branch: head }),
                head,
                base,
              });
              Alert.alert(t('workspace.github.title'), t('workspace.github.pr.done', {
                number: pr.number,
                url: pr.url,
              }));
            } catch (caught) {
              Alert.alert(t('workspace.github.title'), describeError(caught));
            } finally {
              if (mountedRef.current) setPrBusy(false);
            }
          },
        },
      ]
    );
  }, [current, describeError, prBusy, pullBranch, t, token]);

  return {
    historyOpen,
    setHistoryOpen,
    historyCommits,
    historyPage,
    historyBusy,
    historyError,
    historyDiff,
    prBusy,
    loadHistory,
    openCommitDiff,
    submitCreatePr,
  };
}
