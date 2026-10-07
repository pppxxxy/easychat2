// 读取当前会话的分支索引，供消息列表渲染分叉点入口。
// 仅读索引（轻量描述符）；分支正文在切换时按需读取，避免一次拉入大量消息。
// activeSessionId / refreshToken 变化时重载：切会话、撤回归档、切换、删除分支都会刷新。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { groupBranchesByFork } from './branchTree.js';
import { getBranchIndexStatus } from '../storage/sessionBranches.js';

export default function useChatBranches({ activeSessionId, refreshToken }) {
  const [branches, setBranches] = useState([]);
  const [loading, setLoading] = useState(false);
  const sessionIdRef = useRef('');
  sessionIdRef.current = String(activeSessionId || '');

  const reload = useCallback(() => {
    const sessionId = String(activeSessionId || '');
    if (!sessionId) {
      setBranches([]);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    getBranchIndexStatus(sessionId)
      .then(result => {
        if (cancelled || sessionIdRef.current !== sessionId) return;
        setBranches(result && result.status === 'ok' && Array.isArray(result.branches)
          ? result.branches
          : []);
      })
      .catch(() => {
        if (!cancelled) setBranches([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [activeSessionId]);

  useEffect(() => {
    const cleanup = reload();
    return cleanup;
  }, [reload, refreshToken]);

  const branchesByFork = useMemo(() => groupBranchesByFork(branches), [branches]);

  return { branches, branchesByFork, loading, reload };
}
