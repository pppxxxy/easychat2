import { useCallback, useState } from 'react';
import { Alert } from 'react-native';
import * as Clipboard from 'expo-clipboard';

import {
  canDeleteRepo,
  createRepo,
  deleteRepo,
  fetchTokenScopes,
  renameRepo,
  repoWebUrl,
} from '../../github/restApi.js';

// 仓库管理域：⑤ 新建仓库、⑥ 仓库管理（复制链接 / 重命名 / 删除）。
// 从 GithubPanel 原样搬出（行为不变）；仓库列表与仓库态由面板注入。
export default function useRepoManage({
  characterId,
  storeRef,
  current,
  token,
  describeError,
  refreshLocal,
  mountedRef,
  t,
  selectRepo,
  setRepos,
  setCurrent,
  setSubdir,
  setLayer,
  setActionBusy,
}) {
  const [newRepo, setNewRepo] = useState({ name: '', description: '', isPrivate: true, autoInit: false });
  const [renameValue, setRenameValue] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [scopes, setScopes] = useState([]);

  const openManage = useCallback(async () => {
    if (!current) {
      Alert.alert(t('workspace.github.title'), t('workspace.github.manage.needRepo'));
      return;
    }
    setRenameValue(current.repo);
    setDeleteConfirm('');
    setLayer('manage');
    if (token) {
      try {
        const list = await fetchTokenScopes({ token });
        if (mountedRef.current) setScopes(list);
      } catch (caught) {
        if (mountedRef.current) setScopes([]);
      }
    }
  }, [current, mountedRef, setDeleteConfirm, setLayer, setRenameValue, t, token]);

  const copyRepoLink = useCallback(async () => {
    if (!current) return;
    try {
      await Clipboard.setStringAsync(repoWebUrl(current.owner, current.repo));
      Alert.alert(t('workspace.github.title'), t('workspace.github.manage.copied'));
    } catch (caught) {}
  }, [current, t]);

  const submitRename = useCallback(async () => {
    if (!current) return;
    const next = renameValue.trim();
    if (!next || next === current.repo) return;
    setActionBusy('rename');
    try {
      const updated = await renameRepo({ token, owner: current.owner, repo: current.repo, newName: next });
      const branch = updated.defaultBranch || current.branch;
      // 本地副本目录同步改名（repos/<owner>/<旧名> → repos/<owner>/<新名>）。
      // 失败不阻断重命名（远端已改成功），只如实告知本地目录没跟着动。
      const store = storeRef && storeRef.current;
      let movedLocal = false;
      if (store && typeof store.moveWorkspaceDirectory === 'function') {
        try {
          const moved = await store.moveWorkspaceDirectory({
            characterId,
            from: `repos/${current.owner}/${current.repo}`,
            to: `repos/${updated.owner}/${updated.repo}`,
          });
          movedLocal = Boolean(moved && moved.moved);
        } catch (error) {
          movedLocal = false;
        }
      }
      if (mountedRef.current) {
        setRepos(prev => prev.map(item => (item.fullName === `${current.owner}/${current.repo}` ? updated : item)));
        setCurrent({ owner: updated.owner, repo: updated.repo, branch });
        setSubdir(`repos/${updated.owner}/${updated.repo}/${branch}/`);
        setLayer('');
      }
      await refreshLocal();
      Alert.alert(t('workspace.github.title'), t(
        movedLocal ? 'workspace.github.manage.renamedAndMoved' : 'workspace.github.manage.renamed'
      ));
    } catch (caught) {
      Alert.alert(t('workspace.github.title'), describeError(caught));
    } finally {
      if (mountedRef.current) setActionBusy('');
    }
  }, [characterId, current, describeError, refreshLocal, renameValue, setActionBusy, setCurrent, setLayer, setRepos, setSubdir, storeRef, t, token]);

  // 删除仓库——三层硬约束，任缺一层都删不掉：
  // ① UI：必须手动输入完整仓库名（下面按 deleteConfirm 是否匹配禁用按钮）；
  // ② 权限：token 必须带 delete_repo scope（没勾时明确提示去哪勾）；
  // ③ 后端：restApi.deleteRepo 要求 confirm 逐字相同，否则连请求都不发。
  const submitDelete = useCallback(async () => {
    if (!current) return;
    const fullName = `${current.owner}/${current.repo}`;
    if (deleteConfirm.trim() !== fullName) return;
    if (!canDeleteRepo(scopes)) return;
    setActionBusy('delete');
    try {
      await deleteRepo({ token, owner: current.owner, repo: current.repo, confirm: fullName });
      if (mountedRef.current) {
        setRepos(prev => prev.filter(item => item.fullName !== fullName));
        setCurrent(null);
        setSubdir('');
        setDeleteConfirm('');
        setLayer('');
      }
      Alert.alert(t('workspace.github.title'), t('workspace.github.manage.deleteDone'));
    } catch (caught) {
      Alert.alert(t('workspace.github.title'), describeError(caught));
    } finally {
      if (mountedRef.current) setActionBusy('');
    }
  }, [current, deleteConfirm, describeError, mountedRef, scopes, setActionBusy, setCurrent, setDeleteConfirm, setLayer, setRepos, setSubdir, t, token]);

  // ⑤ 新建仓库：成功后自动成为当前仓库，并在本地建同名骨架目录。
  const submitCreateRepo = useCallback(async () => {
    const name = newRepo.name.trim();
    if (!name) return;
    setActionBusy('createRepo');
    try {
      const created = await createRepo({
        token,
        name,
        description: newRepo.description,
        isPrivate: newRepo.isPrivate,
        autoInit: newRepo.autoInit,
      });
      const branch = created.defaultBranch || 'main';
      const store = storeRef && storeRef.current;
      if (store) {
        await store
          .createWorkspaceDirectory({ characterId, path: `repos/${created.owner}/${created.repo}/${branch}` })
          .catch(() => {});
      }
      if (mountedRef.current) {
        setRepos(prev => [created, ...prev.filter(item => item.fullName !== created.fullName)]);
        setNewRepo({ name: '', description: '', isPrivate: true, autoInit: false });
      }
      selectRepo(created);
      await refreshLocal();
      Alert.alert(t('workspace.github.title'), t('workspace.github.createRepo.done', { name: created.fullName }));
    } catch (caught) {
      Alert.alert(t('workspace.github.title'), describeError(caught));
    } finally {
      if (mountedRef.current) setActionBusy('');
    }
  }, [characterId, describeError, mountedRef, newRepo, refreshLocal, selectRepo, setActionBusy, setRepos, storeRef, t, token]);

  return {
    newRepo,
    setNewRepo,
    renameValue,
    setRenameValue,
    deleteConfirm,
    setDeleteConfirm,
    scopes,
    openManage,
    copyRepoLink,
    submitRename,
    submitDelete,
    submitCreateRepo,
  };
}
