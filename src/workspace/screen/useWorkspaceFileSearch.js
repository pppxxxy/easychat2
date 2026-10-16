// FEAT-AC12 P1：文件面板搜索的 React 接线（把纯调度器接到组件状态上）。
//
// 为什么单独一个模块、而不是把这几行塞进 FilesPanel：
//   · FilesPanel 已贴 800 行棘轮基线，不能再堆代码（AGENTS.md 的「优先抽子模块」）；
//   · 把「输入态 → 消费态」的接线收在一处，FilesPanel 只留一次调用——
//     两个状态各自演化（同一个值被改一处忘另一处）是本类缺陷的经典形态。
//
// 调度判据（连发只消费一次 / 清空立即生效 / 计时器可清理）全在纯模块
// fileSearchDebounce.js 里，由 Node 直测；这里只负责 React 生命周期。

import { useEffect, useMemo, useRef, useState } from 'react';

import { searchWorkspaceFiles } from '../fileSearch.js';
import { createSearchDebouncer, shouldLoadFullList, SEARCH_DEBOUNCE_MS } from '../fileSearchDebounce.js';

/**
 * 把「即时受控的输入值」变成「防抖后的消费值」，并顺带产出搜索结果。
 *
 * @param {object} args
 * @param {string} args.query 输入框的即时值（**受控**，打字手感不回退）
 * @param {Array<string>} args.files 当前已加载的清单（用于本地搜索）
 * @param {{ current: { full: boolean } }} args.filesRef 清单是否已是全量
 * @param {Function} args.refresh 加载入口（`refresh(ownerId, { full })`）
 * @param {number} [args.delayMs] 防抖窗口
 * @returns {{ debouncedQuery: string, fileSearch: object }}
 */
export function useWorkspaceFileSearch({
  query,
  files,
  filesRef,
  refresh,
  delayMs = SEARCH_DEBOUNCE_MS,
}) {
  const [debouncedQuery, setDebouncedQuery] = useState(query);
  // refresh 的引用会随 subdir/characterId 变化（useCallback 依赖），用 ref 取最新值，
  // 否则调度器会把**第一次渲染**的 refresh 一直用下去（切目录后搜不到新目录）。
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  const debouncerRef = useRef(null);
  if (debouncerRef.current === null) {
    debouncerRef.current = createSearchDebouncer({
      delayMs,
      commit: next => {
        setDebouncedQuery(next);
        // 全量加载也挂在窗口结束之后（此前是**首个字符**就触发整树 walk）。
        // 「该不该拉」的判据在纯模块里（可行为测试）；filesRef 守卫仍在，防重复全量。
        const alreadyFull = Boolean(filesRef.current && filesRef.current.full);
        if (!shouldLoadFullList({ query: next, alreadyFull })) return;
        if (filesRef.current) filesRef.current.full = true;
        const load = refreshRef.current;
        if (typeof load === 'function') load(undefined, { full: true }).catch(() => {});
      },
    });
  }

  useEffect(() => {
    debouncerRef.current.push(query);
    // 卸载/输入变化时清掉挂起的计时器：禁止泄漏（任务书要求）。
    return () => debouncerRef.current.cancel();
  }, [query]);

  // 消费路径只认防抖值：每个字符不再各扫一遍全量清单 + 重渲结果。
  const fileSearch = useMemo(
    () => searchWorkspaceFiles(files, debouncedQuery),
    [files, debouncedQuery]
  );

  return { debouncedQuery, fileSearch };
}
