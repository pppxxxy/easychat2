import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';

import { getRepoSnapshot, setRepoSnapshot } from '../../../storage/workspace.js';
import { classifyPullGuard, diffRepoSnapshot, localRepoPaths, pullGuardCopy } from '../repoDiff.js';
import { downloadZip } from '../../github/restApi.js';
import {
  buildPullSkippedPayload,
  buildRepoZipUrl,
  clearPullManifest,
  extractRepoFiles,
  readPullManifest,
  readPullSkipped,
  REPO_IMPORT_LIMITS,
  writePullManifest,
  writePullSkipped,
} from '../../repoImport.js';

const PULL_KEEP_AWAKE_TAG = 'easychat2-repo-pull';

// 拉取（重拉远端快照到本地副本）域：进度/ETA/前台提示、覆盖确认、跳过清单。
// 从 GithubPanel 原样搬出（行为不变）；store/仓库态/刷新由面板注入。
// R0/R1（2026-10-12 spec repo-pull-resilience）：
//   · 传输预算在 restApi.downloadZip（重试 3 次 + body 停滞掐表 + 超时分级）；
//   · 拉取全程 KeepAwake（进程被杀是残缺主因之一）；
//   · 守卫裁决序走 classifyPullGuard——manifest 残留（dirtyPull）不再误报
//     「未推送的改动」，改弹说明性的「重新拉取将修复缺失文件」。
export default function useRepoPull({
  characterId,
  storeRef,
  current,
  pullBranch,
  token,
  describeError,
  refreshLocal,
  mountedRef,
  t,
  setCurrent,
  setSubdir,
  setSnapshotPaths,
}) {
  const [pullBusy, setPullBusy] = useState(false);
  const [pullProgress, setPullProgress] = useState({ done: 0, total: 0 });
  const [pullNotice, setPullNotice] = useState('');
  const [pullEta, setPullEta] = useState(0);
  const pullStartRef = useRef(0);
  const pullCancelRef = useRef(false);
  const [skippedPayload, setSkippedPayload] = useState(null);
  const [skippedOpen, setSkippedOpen] = useState(false);
  // R1-3：manifest 残留态暴露给面板（推送区置灰的数据源）。挂载时读一次；
  // pullSnapshot 内实时刷新（进入时读、成功后清空、写出清单后失败时保留）。
  const [pullManifest, setPullManifest] = useState(null);

  // G2：面板（重）挂载时读上次拉取的跳过清单——「跳过 N 个文件（可查看清单）」
  // 在会话之间也保留（agent 同样能用 read_workspace_file 读 .easychat/pull-skipped.json）。
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const payload = await readPullSkipped(storeRef && storeRef.current, characterId);
        if (alive && payload && payload.total > 0) {
          setSkippedPayload(payload);
        }
      } catch (error) {}
      try {
        const manifest = await readPullManifest(storeRef && storeRef.current, characterId);
        if (alive) setPullManifest(manifest);
      } catch (error) {}
    })();
    return () => { alive = false; };
  }, [characterId, storeRef]);

  // B3（R1 改版）：覆盖确认——Promise 化 Alert（**问不到用户 = 不继续**，与工具
  // 审批同款原则）；点外部/返回键按取消结算，绝不默认放行。旧版只报合并计数
  // （added+removed），残缺态下把缺口吓唬成「你的未推送改动」；R1 起 dirtyPull
  // 走说明框、overwrite 走拆分双数字框（文案键由 pullGuardCopy 裁决）。
  const confirmPullAsk = useCallback((titleKey, body, actionKey) => new Promise(resolve => {
    Alert.alert(
      t(titleKey),
      body,
      [
        { text: t('common.cancel'), style: 'cancel', onPress: () => resolve(false) },
        { text: t(actionKey), style: 'destructive', onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) }
    );
  }), [t]);

  const pullSnapshot = useCallback(async () => {
    if (!current || pullBusy) return;
    const store = storeRef && storeRef.current;
    if (!store) return;
    const branch = String(pullBranch || current.branch || '').trim() || current.branch;
    setPullBusy(true);
    setPullProgress({ done: 0, total: 0 });
    setPullNotice('');
    setPullEta(0);
    pullStartRef.current = Date.now();
    pullCancelRef.current = false;
    let batchOpen = false;
    // R0-3：拉取期间保持屏幕常亮——上千文件的写入窗口里 app 被系统杀掉是残缺的
    // 直接根源；activate/deactivate 都绝不挡主流程（失败静默）。
    let keepAwakeOn = false;
    try {
      await activateKeepAwakeAsync(PULL_KEEP_AWAKE_TAG).then(() => { keepAwakeOn = true; }).catch(() => {});
      // —— R1-1：入口统一裁决序（先查 manifest 残留，再谈覆盖守卫）——
      // 旧版 B3 守卫与 F4 残留检测互不联动：manifest 残留（= 上次拉取中断、本地是
      // 不完整中间态）时照弹「你有 N 处未推送改动」，把缺口和残骸算成用户的工作。
      const base = `repos/${current.owner}/${current.repo}/${branch}/`;
      let staleManifest = null;
      try {
        staleManifest = await readPullManifest(store, characterId);
      } catch (error) {}
      if (mountedRef.current) setPullManifest(staleManifest);
      try {
        const baseline = await getRepoSnapshot(characterId, `${current.owner}/${current.repo}/${branch}`);
        const guardFiles = await store.listWorkspaceFiles({ characterId });
        const guardLocal = localRepoPaths({ files: guardFiles, prefix: base });
        const guardDiff = diffRepoSnapshot({
          files: guardFiles,
          prefix: base,
          snapshotPaths: baseline && Array.isArray(baseline.paths) ? baseline.paths : [],
        });
        const decision = classifyPullGuard({ manifest: staleManifest, diff: guardDiff, hasLocal: guardLocal.length > 0 });
        if (decision.kind === 'dirtyPull') {
          // (a) manifest 残留 → dirtyPull 态：**跳过 B3 覆盖守卫**，改弹说明性确认。
          const copy = pullGuardCopy({ decision });
          const proceed = await confirmPullAsk(
            'workspace.github.pull.dirtyTitle',
            t(copy.key, copy.params),
            'workspace.github.pull.dirtyConfirm'
          );
          if (!proceed) return;
        } else if (decision.kind === 'overwrite') {
          // (b) 无残留且有增删 → B3 守卫，文案按 added/removed 拆分报告。
          const copy = pullGuardCopy({ decision });
          const proceed = await confirmPullAsk(
            'workspace.github.pull.overwriteTitle',
            t(copy.key, copy.params),
            'workspace.github.pull.overwriteConfirm'
          );
          if (!proceed) return;
        }
        // (c) clean：本地为空（首次拉取）或与基线一致，直接放行。
      } catch (error) {}
      const url = buildRepoZipUrl({ owner: current.owner, repo: current.repo, branch });
      // C4+R0：zip 下载走统一传输层（超时分级 + 断流整包重试 3 次 + body 停滞掐表 +
      // content-length 预检；HTTP 错误已在传输层按 mapGithubError 抛出，走到这里必是
      // 2xx 且拿到完整字节。codeload 不回 length——真实字节数由 extractRepoFiles 复核）。
      const { bytes } = await downloadZip({ url, token, maxBytes: REPO_IMPORT_LIMITS.MAX_DOWNLOAD_BYTES });
      const { files, skippedBinary, skippedSlip, skippedOversize, skippedDirs, skipped } = extractRepoFiles(
        bytes,
        `${current.repo}-${branch}/`
      );
      // G2：跳过清单落盘（覆盖式——本次没跳过就覆盖为空，如实反映最近一次拉取）。
      // 写失败不挡拉取主流程（旁路机制）。
      const skippedPayloadNext = buildPullSkippedPayload({
        owner: current.owner,
        repo: current.repo,
        branch,
        skipped,
      });
      if (files.length === 0) {
        Alert.alert(t('workspace.github.title'), t('workspace.github.pull.noFiles'));
        return;
      }
      // F4：残留提示（裁决序已据 staleManifest 分流——这里只保留人读的进度说明）。
      if (staleManifest && mountedRef.current) {
        setPullNotice(t('workspace.github.pull.resumeNote', { count: staleManifest.files }));
      }
      if (typeof store.beginBatch === 'function') {
        store.beginBatch(characterId, { path: base });
        batchOpen = true;
      }
      // F4：清单写进 batch 内（不产生额外的历史噪音）；写失败不挡拉取主流程。
      const manifestWritten = await writePullManifest(store, characterId, {
        owner: current.owner,
        repo: current.repo,
        branch,
        files: files.length,
      });
      // R1-3：进入写入窗口即置残留态（推送面板据此置灰；失败/取消路径保留它，
      // 与磁盘上的 manifest 同语义）。
      if (manifestWritten && mountedRef.current) {
        setPullManifest({ owner: current.owner, repo: current.repo, branch, files: files.length });
      }
      let written = 0;
      for (let index = 0; index < files.length; index += 1) {
        if (pullCancelRef.current) {
          throw Object.assign(new Error('pull cancelled'), { code: 'PULL_CANCELLED' });
        }
        await store.writeWorkspaceFile({
          characterId,
          path: `${base}${files[index].path}`,
          content: files[index].content,
        });
        written += 1;
        if (index % 5 === 4 || index === files.length - 1) {
          setPullProgress({ done: written, total: files.length });
          // F4：按已写速率估算剩余——用户要的是「还要等多久」的量级，不追求精确。
          const elapsed = (Date.now() - pullStartRef.current) / 1000;
          if (written > 0 && elapsed > 0) {
            setPullEta(Math.max(1, Math.round((elapsed / written) * (files.length - written))));
          }
        }
      }
      if (batchOpen) { store.endBatch?.(); batchOpen = false; }
      // F4：跑到这里才算真的完成——删除残留清单（失败/取消路径会保留它）。
      await clearPullManifest(store, characterId);
      if (mountedRef.current) setPullManifest(null);
      // G2：成功后才写跳过清单（失败/取消不写——避免误导成「这次拉取的结论」）。
      await writePullSkipped(store, characterId, skippedPayloadNext);
      if (mountedRef.current) setSkippedPayload(skippedPayloadNext);
      if (mountedRef.current) {
        setCurrent(prev => (prev ? { ...prev, branch } : prev));
        setSubdir(base);
      }
      await refreshLocal();
      // 拉取成功即刷新基线：快照 = 本地副本当前清单（以刷新后的实际列表为准）。
      const pulledId = `${current.owner}/${current.repo}/${branch}`;
      try {
        const list = await store.listWorkspaceFiles({ characterId });
        const paths = localRepoPaths({ files: list, prefix: base });
        await setRepoSnapshot(characterId, pulledId, { paths });
        if (mountedRef.current) setSnapshotPaths(paths);
      } catch (error) {}
      Alert.alert(t('workspace.github.title'), t('workspace.github.pull.done', {
        count: written,
        binary: skippedBinary,
        oversize: skippedOversize,
        slip: skippedSlip,
        dirs: skippedDirs,
      }));
    } catch (caught) {
      if (batchOpen) { store.abortBatch?.(); batchOpen = false; }
      if (caught && caught.code === 'PULL_CANCELLED') {
        Alert.alert(t('workspace.github.title'), t('workspace.github.pull.cancelled'));
      } else {
        Alert.alert(t('workspace.github.title'), describeError(caught));
      }
    } finally {
      // R0-3：无论成败都解除常亮（deactivate 绝不抛——旁路机制）。
      if (keepAwakeOn) { deactivateKeepAwake(PULL_KEEP_AWAKE_TAG).catch(() => {}); }
      if (mountedRef.current) {
        setPullBusy(false);
        setPullProgress({ done: 0, total: 0 });
      }
    }
  }, [characterId, confirmPullAsk, current, describeError, pullBranch, pullBusy, refreshLocal, storeRef, t, token, setCurrent, setSubdir, setSnapshotPaths]);

  return {
    pullBusy,
    pullProgress,
    pullNotice,
    pullEta,
    pullCancelRef,
    pullManifest,
    skippedPayload,
    skippedOpen,
    setSkippedOpen,
    confirmPullAsk,
    pullSnapshot,
  };
}
