import { useCallback, useMemo } from 'react';
import { Alert } from 'react-native';

import { isTextLike, readTextAttachment } from '../../../chat/attachments.js';
import { ensureDirectoryName, ensureTextFileName } from '../../naming.js';
import { materializeRepoFile } from '../../repoMaterialize.js';

// 文件树浏览域：树内搜索、打开文件（含未物化按需拉取）、导入本地文件、新建文件/文件夹。
// 从 GithubPanel 原样搬出（行为不变）；仓库态与本地树由面板注入。
export default function useRepoFiles({
  characterId,
  storeRef,
  current,
  allFiles,
  subdir,
  search,
  entryForm,
  repoPrefix,
  refreshLocal,
  virtualPaths,
  token,
  mountedRef,
  t,
  setPreview,
  setLayer,
  setEntryForm,
  setActionBusy,
}) {
  // 搜索：过滤当前仓库树的全部文件（本地副本全量路径匹配，不区分大小写）。
  const searchResults = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    if (!keyword) return [];
    const prefix = repoPrefix(current);
    return allFiles
      .filter(entry => !String(entry).endsWith('/'))
      .filter(entry => String(entry).startsWith(prefix))
      .filter(entry => entry.toLowerCase().includes(keyword))
      .slice(0, 50);
  }, [allFiles, current, repoPrefix, search]);

  const openFile = useCallback(async path => {
    const store = storeRef && storeRef.current;
    if (!store) return;
    try {
      const result = await store.readWorkspaceFile({ characterId, path });
      if (mountedRef.current) {
        setPreview(result);
        setLayer('preview');
      }
    } catch (caught) {
      // C2：清单里存在但本地没物化 → 点开即拉（单文件 contents API），拉完重读。
      // 明确失败（网络/超过单文件上限）时如实报——绝不静默停在打不开的状态。
      if (virtualPaths.has(path)) {
        try {
          const materialized = await materializeRepoFile({ store, characterId, path, token });
          if (materialized.ok) {
            const result = await store.readWorkspaceFile({ characterId, path });
            if (mountedRef.current) {
              setPreview(result);
              setLayer('preview');
            }
            await refreshLocal();
            return;
          }
          Alert.alert(
            t('workspace.github.title'),
            materialized.reason === 'none'
              ? t('workspace.github.materialize.tooLarge')
              : t('workspace.github.materialize.fail')
          );
          return;
        } catch (error) {
          Alert.alert(t('workspace.github.title'), t('workspace.github.materialize.fail'));
          return;
        }
      }
      Alert.alert(t('workspace.github.title'), t('workspace.github.err.open'));
    }
  }, [characterId, mountedRef, refreshLocal, setLayer, setPreview, storeRef, t, token, virtualPaths]);

  // ② 导入本地文件：手机多选 → 文本文件写进当前仓库的本地副本。
  const importLocalFiles = useCallback(async () => {
    if (!current) {
      Alert.alert(t('workspace.github.title'), t('workspace.github.importLocal.noRepo'));
      return;
    }
    const store = storeRef && storeRef.current;
    if (!store) return;
    setActionBusy('import');
    try {
      const DocumentPicker = require('expo-document-picker');
      const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
      if (!result || result.canceled) return;
      const assets = Array.isArray(result.assets) ? result.assets : [];
      let written = 0;
      let skipped = 0;
      for (const asset of assets) {
        const name = String((asset && asset.name) || '').split('/').pop() || '';
        if (!name || !isTextLike(name, asset && asset.mime)) {
          skipped += 1;
          continue;
        }
        try {
          const text = await readTextAttachment(asset.uri);
          await store.writeWorkspaceFile({ characterId, path: `${repoPrefix(current)}${name}`, content: text });
          written += 1;
        } catch (caught) {
          skipped += 1;
        }
      }
      await refreshLocal();
      if (mountedRef.current) {
        Alert.alert(t('workspace.github.title'), t('workspace.github.importLocal.done', { written, skipped }));
      }
    } catch (caught) {
      Alert.alert(t('workspace.github.title'), t('workspace.github.importLocal.errBody'));
    } finally {
      if (mountedRef.current) setActionBusy('');
    }
  }, [characterId, current, mountedRef, refreshLocal, repoPrefix, setActionBusy, storeRef, t]);

  // ③ 新建文件 / 文件夹：落点 = 树内当前目录。
  const submitEntry = useCallback(async () => {
    const store = storeRef && storeRef.current;
    if (!store || !current) return;
    const name = String(entryForm.name || '').trim();
    if (!name) return;
    setActionBusy('entry');
    try {
      if (entryForm.kind === 'folder') {
        const path = ensureDirectoryName(name);
        await store.createWorkspaceDirectory({ characterId, path: `${subdir}${path}` });
      } else {
        const path = ensureTextFileName(name);
        await store.writeWorkspaceFile({ characterId, path: `${subdir}${path}`, content: String(entryForm.content || '') });
      }
      setEntryForm({ kind: entryForm.kind, name: '', content: '' });
      setLayer('');
      await refreshLocal();
    } catch (caught) {
      Alert.alert(t('workspace.github.title'), t('workspace.github.err.save'));
    } finally {
      if (mountedRef.current) setActionBusy('');
    }
  }, [characterId, current, entryForm, mountedRef, refreshLocal, setActionBusy, setEntryForm, setLayer, storeRef, subdir, t]);

  return { searchResults, openFile, importLocalFiles, submitEntry };
}
