// 获取域：在线下载 / 本地导入两条互斥路径的草稿与任务态（U2/U4/U5）。
// 任务态用单对象 { kind, progress, writtenBytes, totalBytes } 表达（C2 的实质）：
// kind 为空即「没有任务在跑」，不存在「busy=true 但任务已死」的孤儿态。
// 反馈约定同 usePanelModels：不弹 Alert，返回 { ok, code, message } 由壳映射。
//
// 状态机（useReducer）：本域四个状态（子 Tab / 下载草稿 / 导入草稿 / 任务）本来就是
// 一台「获取流程」的状态机，收成一个 reducer 后所有迁移都走 dispatch，杜绝散落的
// setXxx 交叉更新（U4 的取消 + U2 的草稿互斥都靠类型化的 action 表达）。
// 对外接口与旧 useState 版完全一致（setter 兼容函数式更新），壳不需要改动。

import { useCallback, useEffect, useReducer, useRef } from 'react';

import * as DocumentPicker from 'expo-document-picker';

import { importLocalModel } from '../modelManager.js';
import {
  cancelQueuedDownload,
  enqueueDownload,
  getDownloadQueueSnapshot,
  subscribeDownloadQueue,
} from '../downloadQueue.js';
import { rewriteDownloadSourceUrl } from '../modelCatalog.js';
import { buildModelSummary } from '../modelCompatibility.js';
import { getPickedAsset } from '../../character/cardHelpers.js';
import { emptyDownloadDraft, emptyImportDraft } from './panelShared.js';
import { acquireReducer, IDLE_TASK } from './acquireReducer.js';

export function useAcquireModel({ deviceMemoryBytes, onChanged }) {
  const [state, dispatch] = useReducer(acquireReducer, undefined, () => ({
    tab: 'download',
    downloadDraft: emptyDownloadDraft(),
    importDraft: emptyImportDraft(),
    task: IDLE_TASK,
  }));
  const { tab: acquireTab, downloadDraft, importDraft, task } = state;

  const setAcquireTab = useCallback(value => dispatch({ type: 'tab', value }), []);
  const setDownloadDraft = useCallback(value => dispatch({ type: 'downloadDraft', value }), []);
  const setImportDraft = useCallback(value => dispatch({ type: 'importDraft', value }), []);
  const setTask = useCallback(value => dispatch({ type: 'task', value }), []);

  // 任务态不再由本组件持有：镜像持久化下载队列的当前任务（v5 Stage B）。
  // 面板关掉再打开、甚至 app 重启后，队列仍在推进（重启后 running→pending 重下）。
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  const knownIdsRef = useRef(new Set());
  // 取消按钮的目标 id 只能来自队列自身（task.id），**绝不能从草稿反推**：
  // 入队成功后草稿即被清空、用户还可能已重输 modelId，反推出来的 id 要么为空
  // （取消无效），要么指向另一个任务（取消到别人）。这里镜像快照里的真实任务 id。
  const activeTaskIdRef = useRef('');
  useEffect(() => {
    let active = true;
    const sync = snapshot => {
      if (!active) return;
      const current = snapshot && snapshot.current;
      const pending = snapshot && snapshot.tasks.find(item => item.status === 'pending');
      // 真实任务 id：正在跑的任务优先，其次排队中的第一个（与下方 task 派生同一口径）。
      activeTaskIdRef.current = String((current && current.id) || (pending && pending.id) || '');
      if (current) {
        setTask({
          kind: 'download',
          // 快照 progress 已是 0–100 百分数（downloadQueue 出口收口），原样透传即可。
          progress: Number(current.progress) || 0,
          writtenBytes: Number(current.writtenBytes) || 0,
          totalBytes: Number(current.totalBytes) || 0,
          modelId: current.id,
        });
      } else if (pending) {
        // 排队等待中：进度 0，但 kind 非空以显示「下载中」。
        setTask({ kind: 'download', progress: 0, writtenBytes: 0, totalBytes: 0, modelId: pending.id });
      } else {
        setTask(IDLE_TASK);
      }
      // 任务完成（从快照消失）后刷新已装列表：队列与面板解耦，完成时主动通知一次。
      const currentIds = new Set((snapshot && snapshot.tasks ? snapshot.tasks : []).map(item => item.id));
      for (const id of knownIdsRef.current) {
        if (!currentIds.has(id)) {
          Promise.resolve(onChangedRef.current && onChangedRef.current()).catch(() => {});
          break;
        }
      }
      knownIdsRef.current = currentIds;
    };
    const unsubscribe = subscribeDownloadQueue(sync);
    sync(getDownloadQueueSnapshot());
    return () => { active = false; unsubscribe(); };
  }, [setTask]);

  const draftSummary = buildModelSummary(
    { name: `${downloadDraft.name} ${downloadDraft.modelId}`, quant: downloadDraft.quant, paramSize: downloadDraft.paramSize },
    { totalMemoryBytes: deviceMemoryBytes, contextSize: 2048 }
  );

  const handleDownload = useCallback(async () => {
    const url = downloadDraft.modelUrl.trim();
    if (!downloadDraft.modelId.trim() || !/^https?:\/\//i.test(url)) {
      return { ok: false, code: 'INCOMPLETE_INPUT' };
    }
    // 入队即返回：真正的下载由持久化队列串行执行，与面板生命周期解耦。
    const result = await enqueueDownload({
      modelId: downloadDraft.modelId,
      name: downloadDraft.name || downloadDraft.modelId,
      modelUrl: url,
      sourceId: downloadDraft.sourceId,
      repoPath: downloadDraft.repoPath,
      quant: downloadDraft.quant,
      paramSize: downloadDraft.paramSize,
      modelExpectedBytes: downloadDraft.modelExpectedBytes,
      modelSha256: downloadDraft.modelSha256,
      mmprojUrl: downloadDraft.mmprojUrl,
    });
    if (!result.ok) return { ok: false, code: result.code };
    // 重复入队（队列已有同 id 任务）：必须把 DUPLICATE 透传出去，否则反馈层会当成
    // 「已加入队列」并（旧实现）照常清空草稿——用户看到成功提示、DUPLICATE 静默分支
    // 成了死代码。这里保留草稿，用户可改 URL/量化后重试。
    if (result.code === 'DUPLICATE') return { ok: false, code: 'DUPLICATE' };
    // 入队即返回：真正的下载由持久化队列串行执行，与面板生命周期解耦。
    // 任务 id 以快照为准（订阅回调会写 activeTaskIdRef，规则单一：取消的目标 = 面板
    // 正在展示的那个任务）；这里只在快照尚未回填时兜底记住入队返回的 id。
    if (!activeTaskIdRef.current) activeTaskIdRef.current = String(result.id || '');
    setDownloadDraft(emptyDownloadDraft());
    return { ok: true, name: downloadDraft.name || downloadDraft.modelId, queued: true };
  }, [downloadDraft, setDownloadDraft]);

  // 取消：用队列快照里的真实任务 id 取消（正在跑的任务走 cancelAsync，排队中的直接移除）。
  // 幂等；没有已知任务 id 时**什么都不做**——宁可这次取消无效，也不能凭草稿推算出 id
  // 去取消别的任务（旧实现的 handleCancelDownload 从草稿推 id，就是死按钮 + 误取消的根因）。
  const handleCancelDownload = useCallback(() => {
    const id = String(activeTaskIdRef.current || '');
    if (!id) return Promise.resolve(false);
    return cancelQueuedDownload(id).catch(() => false);
  }, []);

  const pickGguf = useCallback(async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true, multiple: false });
      const asset = getPickedAsset(result);
      if (!asset || !asset.uri) return { ok: false, code: 'CANCELLED' };
      setImportDraft(current => ({ ...current, sourceUri: asset.uri, name: asset.name || '' }));
      return { ok: true };
    } catch (error) {
      return { ok: false, code: 'PICK_FAILED', message: error && error.message };
    }
  }, [setImportDraft]);

  const pickMmproj = useCallback(async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true, multiple: false });
      const asset = getPickedAsset(result);
      if (!asset || !asset.uri) return { ok: false, code: 'CANCELLED' };
      setImportDraft(current => ({ ...current, mmprojSourceUri: asset.uri, mmprojSourceName: asset.name || '' }));
      return { ok: true };
    } catch (error) {
      return { ok: false, code: 'PICK_FAILED', message: error && error.message };
    }
  }, [setImportDraft]);

  const handleImport = useCallback(async () => {
    if (!importDraft.sourceUri) return { ok: false, code: 'NO_FILE' };
    setTask({ kind: 'import', progress: 0, writtenBytes: 0, totalBytes: 0 });
    try {
      const item = await importLocalModel({
        sourceUri: importDraft.sourceUri,
        name: importDraft.name,
        mmprojSourceUri: importDraft.mmprojSourceUri,
      });
      setImportDraft(emptyImportDraft());
      setTask(IDLE_TASK);
      await onChanged();
      return { ok: true, name: item.name || item.id };
    } catch (error) {
      setTask(IDLE_TASK);
      return { ok: false, code: 'FAILED', message: error && error.message };
    }
  }, [importDraft, onChanged, setImportDraft, setTask]);

  // 选中文件后静默回填（U5）：体积/兼容评估/内存估算由 summaryCard 常驻展示，
  // 不再弹五行小作文。返回摘要给壳——只有「跑不了」档才由壳弹一条警示。
  const handleSearchSelect = useCallback(selection => {
    if (!selection) return null;
    const mmprojUrls = Array.isArray(selection.mmprojUrls) ? selection.mmprojUrls : [];
    setDownloadDraft(current => ({
      ...current,
      modelId: selection.modelId || current.modelId,
      name: selection.modelName || current.name,
      modelUrl: selection.modelUrl || current.modelUrl,
      sourceId: selection.sourceId || current.sourceId,
      repoPath: selection.repoId || '',
      modelExpectedBytes: Number(selection.fileSize) > 0 ? Number(selection.fileSize) : 0,
      modelSha256: selection.fileSha256 || '',
      mmprojUrl: mmprojUrls[0] || '',
      mmprojUrls,
    }));
    return buildModelSummary(
      { name: selection.modelId || selection.modelName || '' },
      { totalMemoryBytes: deviceMemoryBytes, contextSize: 2048 }
    );
  }, [deviceMemoryBytes, setDownloadDraft]);

  const rewriteSource = useCallback(source => {
    setDownloadDraft(current => {
      const rewritten = rewriteDownloadSourceUrl(current.modelUrl, source.id);
      if (rewritten) return { ...current, modelUrl: rewritten, sourceId: source.id };
      const repoPath = String(current.modelUrl || '').replace(/^https?:\/\/[^/]+/i, '').replace(/^\/+/, '');
      return { ...current, modelUrl: repoPath ? `${source.baseUrl}/${repoPath}` : `${source.baseUrl}/`, sourceId: source.id };
    });
  }, [setDownloadDraft]);

  return {
    acquireTab,
    setAcquireTab,
    downloadDraft,
    setDownloadDraft,
    importDraft,
    setImportDraft,
    task,
    draftSummary,
    handleDownload,
    handleCancelDownload,
    pickGguf,
    pickMmproj,
    handleImport,
    handleSearchSelect,
    rewriteSource,
  };
}
