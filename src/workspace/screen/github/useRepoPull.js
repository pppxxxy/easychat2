import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';

import { getRepoSnapshot, setRepoSnapshot } from '../../../storage/workspace.js';
import { diffRepoSnapshot, localRepoPaths } from '../repoDiff.js';
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

// 拉取（重拉远端快照到本地副本）域：进度/ETA/前台提示、覆盖确认、跳过清单。
// 从 GithubPanel 原样搬出（行为不变）；store/仓库态/刷新由面板注入。
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
    })();
    return () => { alive = false; };
  }, [characterId, storeRef]);

  // B3：重拉覆盖确认——Promise 化 Alert（**问不到用户 = 不继续**，与工具审批同款
  // 原则）；点外部/返回键按取消结算，绝不默认放行。
  const confirmPullOverwrite = useCallback(count => new Promise(resolve => {
    Alert.alert(
      t('workspace.github.pull.overwriteTitle'),
      t('workspace.github.pull.overwriteBody', { count }),
      [
        { text: t('common.cancel'), style: 'cancel', onPress: () => resolve(false) },
        { text: t('workspace.github.pull.overwriteConfirm'), style: 'destructive', onPress: () => resolve(true) },
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
    try {
      // B3 覆盖守卫：本地副本相对该分支上次拉取的基线有增删（未推送改动）时，
      // 重拉会静默覆盖同名文件——先问一次。本地为空（首次拉取）或与基线一致
      // 直接放行；守卫本身绝不抛错（读基线/列目录失败按「无风险」处理）。
      const base = `repos/${current.owner}/${current.repo}/${branch}/`;
      try {
        const baseline = await getRepoSnapshot(characterId, `${current.owner}/${current.repo}/${branch}`);
        const guardFiles = await store.listWorkspaceFiles({ characterId });
        const guardLocal = localRepoPaths({ files: guardFiles, prefix: base });
        const guardDiff = diffRepoSnapshot({
          files: guardFiles,
          prefix: base,
          snapshotPaths: baseline && Array.isArray(baseline.paths) ? baseline.paths : [],
        });
        if (guardLocal.length > 0 && guardDiff.pending > 0) {
          const proceed = await confirmPullOverwrite(guardDiff.pending);
          if (!proceed) return;
        }
      } catch (error) {}
      const url = buildRepoZipUrl({ owner: current.owner, repo: current.repo, branch });
      // C4：zip 下载走统一传输层（90s 超时 + 断流整包重试 1 次；HTTP 错误已在
      // 传输层按 mapGithubError 抛出，走到这里必是 2xx）。
      const response = await downloadZip({ url, token });
      const declared = Number(response.headers.get('content-length') || 0);
      if (declared > REPO_IMPORT_LIMITS.MAX_DOWNLOAD_BYTES) {
        throw Object.assign(new Error('zip too large'), { code: 'REPO_LIMIT_DOWNLOAD' });
      }
      const buffer = await response.arrayBuffer();
      const { files, skippedBinary, skippedSlip, skippedOversize, skippedDirs, skipped } = extractRepoFiles(
        new Uint8Array(buffer),
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
      // F4：残留检测——上次没跑完会留下清单（成功结束才删）；只提示不拦截，
      // 用户看到「上次未完成，本次覆盖重写」即可（重跑全量是幂等的）。
      try {
        const stale = await readPullManifest(store, characterId);
        if (stale && mountedRef.current) {
          setPullNotice(t('workspace.github.pull.resumeNote', { count: stale.files }));
        }
      } catch (error) {}
      if (typeof store.beginBatch === 'function') {
        store.beginBatch(characterId, { path: base });
        batchOpen = true;
      }
      // F4：清单写进 batch 内（不产生额外的历史噪音）；写失败不挡拉取主流程。
      await writePullManifest(store, characterId, {
        owner: current.owner,
        repo: current.repo,
        branch,
        files: files.length,
      });
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
      if (mountedRef.current) {
        setPullBusy(false);
        setPullProgress({ done: 0, total: 0 });
      }
    }
  }, [characterId, confirmPullOverwrite, current, describeError, pullBranch, pullBusy, refreshLocal, storeRef, t, token, setCurrent, setSubdir, setSnapshotPaths]);

  return {
    pullBusy,
    pullProgress,
    pullNotice,
    pullEta,
    pullCancelRef,
    skippedPayload,
    skippedOpen,
    setSkippedOpen,
    confirmPullOverwrite,
    pullSnapshot,
  };
}
