// 环境与配置下载（catalog）的编排：状态 + 写入 / 套餐一键写入 / 自定义 URL 下载。
// 从 screen/FilesPanel.js 原样外提（无行为变化）：宿主面板只保留 store/角色/refresh 等
// 依赖并传入，本 hook 负责全部下载中心状态与动作；展示层在 files/CatalogSheet.js。

import { useCallback, useEffect, useState } from 'react';
import { Alert } from 'react-native';

import { CATALOG_ITEMS, buildCatalogContent, findCatalogBundle, findCatalogItem } from '../../catalog.js';
import { ensureTextFileName, sanitizeWorkspaceFileName } from '../../naming.js';
import { isAllowedWorkspaceOutputFile } from '../../paths.js';

export default function useCatalogDownloads({ storeRef, characterId, mountedRef, files, refresh, t }) {
  // 环境与配置下载：目录弹层、需输入的模板表单（.gitconfig 的提交身份）、自定义 URL。
  const [catalogOpen, setCatalogOpen] = useState(false);
  // 套餐：写入进度 {id, done, total}；条目状态 'absent' | 'same' | 'diff'（弹层打开时比对）。
  const [bundleBusy, setBundleBusy] = useState(null);
  const [catalogStatuses, setCatalogStatuses] = useState({});
  const [catalogInputs, setCatalogInputs] = useState({});
  const [catalogBusyId, setCatalogBusyId] = useState('');
  const [customUrl, setCustomUrl] = useState('');
  const [customBusy, setCustomBusy] = useState(false);

  // —— 环境与配置下载 ——
  // 写入走 store.writeWorkspaceFile：与面板手写同一条路径，自动进历史改动。
  // quiet 变体供套餐逐条调用（不逐条弹框，整组结束统一报告；失败向上抛）。
  const writeCatalogFileQuiet = useCallback(async (path, content) => {
    const store = storeRef.current;
    if (!store) throw new Error('workspace store unavailable');
    await store.writeWorkspaceFile({ characterId, path, content });
    if (mountedRef.current) await refresh();
  }, [characterId, refresh]);

  const writeCatalogFile = useCallback(async (path, content) => {
    const store = storeRef.current;
    if (!store) {
      Alert.alert(t('workspace.panel.err.save'), t('workspace.panel.err.save'));
      return;
    }
    try {
      await store.writeWorkspaceFile({ characterId, path, content });
      if (!mountedRef.current) return;
      await refresh();
      Alert.alert(t('workspace.panel.catalog.doneTitle'), t('workspace.panel.catalog.doneBody', { file: path }));
    } catch (caught) {
      Alert.alert(t('workspace.panel.err.save'), t('workspace.panel.err.save'));
    }
  }, [characterId, refresh, t]);

  const handleCatalogWrite = useCallback(async itemId => {
    const item = findCatalogItem(itemId);
    if (!item || catalogBusyId) return;
    setCatalogBusyId(itemId);
    try {
      const content = buildCatalogContent(item, catalogInputs[itemId] || {});
      await writeCatalogFile(item.file, content);
      setCatalogStatuses(current => ({ ...current, [itemId]: 'same' }));
    } finally {
      if (mountedRef.current) setCatalogBusyId('');
    }
  }, [catalogBusyId, catalogInputs, writeCatalogFile]);

  // 弹层打开时比对每条状态：沙盒没有 → absent；有且内容一致 → same；有但不同 → diff。
  // 只比内容字符串相等，不做 diff UI。gitconfig 内容随输入变化，以当前输入为准。
  const loadCatalogStatuses = useCallback(async () => {
    const store = storeRef.current;
    if (!store) return;
    const next = {};
    for (const item of CATALOG_ITEMS) {
      try {
        if (!files.includes(item.file)) {
          next[item.id] = 'absent';
          continue;
        }
        const result = await store.readWorkspaceFile({ characterId, path: item.file });
        const expected = buildCatalogContent(item, catalogInputs[item.id] || {});
        next[item.id] = String(result && result.content) === expected ? 'same' : 'diff';
      } catch (error) {
        next[item.id] = 'absent';
      }
    }
    if (mountedRef.current) setCatalogStatuses(next);
  }, [catalogInputs, characterId, files]);

  useEffect(() => {
    if (catalogOpen) loadCatalogStatuses();
  }, [catalogOpen, loadCatalogStatuses]);

  // 一键套餐：逐条走单条写入路径（自动进历史改动）；单条失败不中断，结束统一报告。
  const handleBundleWrite = useCallback(async bundleId => {
    const bundle = findCatalogBundle(bundleId);
    if (!bundle || bundleBusy || catalogBusyId) return;
    setBundleBusy({ id: bundleId, done: 0, total: bundle.items.length });
    const failures = [];
    const written = [];
    const gitIdentity = bundle.needsGitIdentity ? (catalogInputs.gitconfig || {}) : {};
    try {
      for (let index = 0; index < bundle.items.length; index += 1) {
        const item = findCatalogItem(bundle.items[index]);
        if (item) {
          try {
            const content = buildCatalogContent(item, item.id === 'gitconfig' ? gitIdentity : {});
            await writeCatalogFileQuiet(item.file, content);
            written.push(item.file);
          } catch (error) {
            failures.push(item.file);
          }
        }
        if (mountedRef.current) setBundleBusy({ id: bundleId, done: index + 1, total: bundle.items.length });
      }
    } finally {
      if (mountedRef.current) setBundleBusy(null);
    }
    await refresh();
    if (mountedRef.current) loadCatalogStatuses();
    if (mountedRef.current) {
      const summary = `${t('workspace.panel.catalog.bundle.donePrefix', { count: written.length })}\n${written.join('\n')}`;
      const failureNote = failures.length > 0
        ? `\n\n${t('workspace.panel.catalog.bundle.failures', { list: failures.join('\n') })}`
        : '';
      Alert.alert(t('workspace.panel.catalog.bundle.doneTitle'), summary + failureNote);
    }
  }, [bundleBusy, catalogBusyId, catalogInputs, loadCatalogStatuses, refresh, t, writeCatalogFileQuiet]);

  // 自定义 URL 下载：仅 https、20s 超时、512KB 上限；文件名取 URL 末段再过命名清洗。
  const handleCustomDownload = useCallback(async () => {
    if (customBusy) return;
    const url = String(customUrl || '').trim();
    if (!/^https:\/\//.test(url)) {
      Alert.alert(t('workspace.panel.catalog.custom.title'), t('workspace.panel.catalog.custom.errHttp'));
      return;
    }
    setCustomBusy(true);
    try {
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = setTimeout(() => { if (controller) controller.abort(); }, 20000);
      let response;
      try {
        response = await fetch(url, { signal: controller ? controller.signal : undefined });
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      if (text.length > 512 * 1024) {
        Alert.alert(t('workspace.panel.catalog.custom.title'), t('workspace.panel.catalog.custom.errSize'));
        return;
      }
      const rawName = url.split('/').pop().split('?')[0] || 'download.txt';
      // 白名单内的名字（如 .gitignore）原样保留；其余走命名清洗并补 .txt。
      const path = isAllowedWorkspaceOutputFile(rawName)
        ? rawName
        : ensureTextFileName(sanitizeWorkspaceFileName(rawName, 'download'));
      await writeCatalogFile(path, text);
      setCustomUrl('');
    } catch (caught) {
      Alert.alert(t('workspace.panel.catalog.custom.title'), t('workspace.panel.catalog.custom.errFetch'));
    } finally {
      if (mountedRef.current) setCustomBusy(false);
    }
  }, [customBusy, customUrl, t, writeCatalogFile]);

  return {
    catalogOpen,
    setCatalogOpen,
    bundleBusy,
    catalogStatuses,
    catalogInputs,
    setCatalogInputs,
    catalogBusyId,
    customUrl,
    setCustomUrl,
    customBusy,
    handleCatalogWrite,
    handleBundleWrite,
    handleCustomDownload,
  };
}
