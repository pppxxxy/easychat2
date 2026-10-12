import { useCallback, useEffect, useState } from 'react';

import { getGithubMcpSettings } from '../../../storage/githubMcp.js';
import { listRepos } from '../../github/restApi.js';

// 仓库列表域：token 读取、仓库列表分页加载、本地树刷新入口、本地条目计数。
// 从 GithubPanel 原样搬出（行为不变）；本地树刷新（refreshLocal）与仓库前缀由面板注入。
export default function useRepoList({
  mountedRef,
  describeError,
  refreshLocal,
  repoPrefix,
  allFiles,
  setActionBusy,
  token,
  setToken,
}) {
  const [loading, setLoading] = useState(true);
  const [repos, setRepos] = useState([]);
  const [repoPage, setRepoPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState('');

  const loadRepos = useCallback(async (page = 1, resolvedToken = token) => {
    if (!resolvedToken) return;
    setBusy(true);
    setErrorText('');
    try {
      const { repos: list, hasMore: more } = await listRepos({ token: resolvedToken, page });
      if (!mountedRef.current) return;
      setRepos(prev => (page === 1 ? list : [...prev, ...list]));
      setRepoPage(page);
      setHasMore(more);
    } catch (caught) {
      if (mountedRef.current) setErrorText(describeError(caught));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [describeError, mountedRef, token]);

  // 打开面板：读 token（与 MCP 同源，不建第二套凭据）→ 拉仓库列表 + 本地树。
  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      try {
        const settings = await getGithubMcpSettings();
        const resolved = settings && settings.enabled
          ? (settings.authMethod === 'oauth' ? settings.githubAccessToken : settings.githubToken)
          : '';
        if (!alive) return;
        setToken(resolved || '');
        await refreshLocal();
        if (resolved) await loadRepos(1, resolved);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [loadRepos, refreshLocal, setToken]);

  const localCount = useCallback(repo => {
    const prefix = repoPrefix(repo);
    if (!prefix) return 0;
    return allFiles.filter(entry => String(entry).startsWith(prefix) && !String(entry).endsWith('/')).length;
  }, [allFiles, repoPrefix]);

  const refreshAll = useCallback(async () => {
    setActionBusy('refresh');
    try {
      await refreshLocal();
      if (token) await loadRepos(1);
    } finally {
      if (mountedRef.current) setActionBusy('');
    }
  }, [loadRepos, mountedRef, refreshLocal, setActionBusy, token]);

  return {
    loading,
    repos,
    repoPage,
    hasMore,
    busy,
    errorText,
    setErrorText,
    setRepos,
    loadRepos,
    localCount,
    refreshAll,
  };
}
