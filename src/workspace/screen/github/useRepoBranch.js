import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';

import { setRepoSnapshot } from '../../../storage/workspace.js';
import { readRepoManifest, writeRepoManifest } from '../../repoImport.js';
import { listBranches, listTree } from '../../github/restApi.js';
import { localRepoPaths } from '../repoDiff.js';

// 分支与物化域：选中仓库后拉分支列表、载入清单缓存、快速检出（写清单 + 基线）。
// 从 GithubPanel 原样搬出（行为不变）；仓库态/刷新由面板注入。
export default function useRepoBranch({
  characterId,
  storeRef,
  current,
  pullBranch,
  token,
  describeError,
  mountedRef,
  t,
  setPullBranch,
  setCurrent,
  setSubdir,
  setSnapshotPaths,
}) {
  const [branchOptions, setBranchOptions] = useState([]);
  const [branchBusy, setBranchBusy] = useState(false);
  const [branchError, setBranchError] = useState(false);
  const [branchOverLimit, setBranchOverLimit] = useState(false);
  const branchSeqRef = useRef(0);

  const [manifestEntries, setManifestEntries] = useState([]);
  const [manifestTruncated, setManifestTruncated] = useState(false);
  const [checkoutBusy, setCheckoutBusy] = useState(false);

  // C1：载入该仓库的清单缓存（快速检出写入；缺失 = 没做过快速检出，行为与旧版一致）。
  useEffect(() => {
    let alive = true;
    if (!current) {
      setManifestEntries([]);
      setManifestTruncated(false);
      return () => { alive = false; };
    }
    const store = storeRef && storeRef.current;
    (async () => {
      try {
        const manifest = await readRepoManifest(store, characterId, {
          owner: current.owner,
          repo: current.repo,
          branch: current.branch || current.defaultBranch,
        });
        if (!alive) return;
        setManifestEntries(manifest && Array.isArray(manifest.entries) ? manifest.entries : []);
        setManifestTruncated(Boolean(manifest && manifest.truncated));
      } catch (error) {
        if (alive) {
          setManifestEntries([]);
          setManifestTruncated(false);
        }
      }
    })();
    return () => { alive = false; };
  }, [characterId, current, storeRef]);

  // B1：选中仓库后拉分支列表（最多 2 页 = 200 个；超过只提示手动输入）。
  // 失败不阻塞——输入框始终可用（清单三态里的「失败」就是一行提示）。
  useEffect(() => {
    const owner = current ? current.owner : '';
    const repo = current ? current.repo : '';
    branchSeqRef.current += 1;
    const seq = branchSeqRef.current;
    if (!owner || !repo) {
      setBranchOptions([]);
      setBranchBusy(false);
      setBranchError(false);
      setBranchOverLimit(false);
      return undefined;
    }
    let alive = true;
    setBranchBusy(true);
    setBranchError(false);
    setBranchOverLimit(false);
    setBranchOptions([]);
    (async () => {
      try {
        const first = await listBranches({ token, owner, repo });
        let names = first;
        let over = false;
        if (first.length >= 100) {
          const second = await listBranches({ token, owner, repo, page: 2 });
          names = [...first, ...second];
          over = second.length >= 100;
        }
        if (!alive || branchSeqRef.current !== seq) return;
        setBranchOptions(names.map(name => ({ name })));
        setBranchOverLimit(over);
      } catch (error) {
        if (!alive || branchSeqRef.current !== seq) return;
        setBranchError(true);
      } finally {
        if (alive && branchSeqRef.current === seq) setBranchBusy(false);
      }
    })();
    return () => { alive = false; };
  }, [current, token]);

  // B2：分支输入框与该仓库的真实默认分支对齐（normalizeRepo.defaultBranch——
  // 硬编码 'main' 会让默认分支叫 develop 的仓库直接 404）。已拉取过的仓库
  // （current.branch 有值 = 当前本地副本的分支）优先它，别把用户切过的分支
  // 重置回默认；换仓库时同步重置，不带旧分支名。
  useEffect(() => {
    const initial = String((current && (current.branch || current.defaultBranch)) || '').trim();
    setPullBranch(initial || 'main');
  }, [current, setPullBranch]);

  const quickCheckout = useCallback(async () => {
    if (!current || checkoutBusy) return;
    const store = storeRef && storeRef.current;
    if (!store) return;
    const branch = String(pullBranch || current.branch || current.defaultBranch || '').trim();
    if (!branch) return;
    setCheckoutBusy(true);
    try {
      const { entries, truncated } = await listTree({
        token,
        owner: current.owner,
        repo: current.repo,
        ref: branch,
      });
      if (entries.length === 0) {
        Alert.alert(t('workspace.github.title'), t('workspace.github.pull.noFiles'));
        return;
      }
      await writeRepoManifest(store, characterId, {
        owner: current.owner,
        repo: current.repo,
        branch,
      }, { entries, truncated });
      if (mountedRef.current) {
        setManifestEntries(entries);
        setManifestTruncated(truncated);
        setCurrent(prev => (prev ? { ...prev, branch } : prev));
        setSubdir(`repos/${current.owner}/${current.repo}/${branch}/`);
      }
      // 基线 = **本地已物化清单**（与完整拉取/推送成功路径同口径）。
      // 绝不能把清单里的全部路径写进基线：那等于宣称「这些文件曾经物化过」，
      // 未物化的远程文件会在下次推送时被 repoPush.diffRemoteLocal 判成「用户删除」
      // 并真的删掉远端（Trees API 的 sha:null 条目）——G1 的删除安全网就此失效
      //（快速检出后直接点推送 = 删掉整仓）。纯函数契约见 repoPush.test.mjs 的
      // 「全量未物化 → 删除恒空 + remoteOnly 点名」。
      try {
        const list = await store.listWorkspaceFiles({ characterId });
        const paths = localRepoPaths({
          files: list,
          prefix: `repos/${current.owner}/${current.repo}/${branch}/`,
        });
        await setRepoSnapshot(characterId, `${current.owner}/${current.repo}/${branch}`, { paths });
        if (mountedRef.current) setSnapshotPaths(paths);
      } catch (error) {}
      if (truncated && mountedRef.current) {
        Alert.alert(t('workspace.github.title'), t('workspace.github.checkout.truncated'));
      }
    } catch (caught) {
      Alert.alert(t('workspace.github.title'), describeError(caught));
    } finally {
      if (mountedRef.current) setCheckoutBusy(false);
    }
  }, [characterId, checkoutBusy, current, describeError, pullBranch, storeRef, t, token, setCurrent, setSubdir, setSnapshotPaths]);

  return {
    branchOptions,
    branchBusy,
    branchError,
    branchOverLimit,
    manifestEntries,
    manifestTruncated,
    checkoutBusy,
    quickCheckout,
  };
}
