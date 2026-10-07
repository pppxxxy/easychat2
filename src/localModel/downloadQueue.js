// 本地模型下载队列（v5 Stage B）：把「下载」从一次性表单动作升级为持久化任务。
//
// 设计要点（对齐设计书 §5）：
// - 任务（task）而非动作：进度/取消/失败重试与任何 UI 生命周期解耦，队列活过 app 重启
//   （persist 到 @easychat2_download_queue，见 storage/localModels.js）。
// - 串行执行：同一时刻只跑 1 个任务，避免连点两个 4GB 模型 = 双写盘并发。
// - 出队预检：磁盘剩余 < 预估大小 × 1.05 时任务直接失败并给出清理指引，不再「下到 95%
//   才发现磁盘满」。
// - 镜像自动回退：huggingface 源失败时用 rewriteDownloadSourceUrl 改写 hf-mirror 续试
//   （改写函数早已存在，本模块只负责接线）。
// - 断点续传 = 「断点重下」（诚实降级）：expo legacy createDownloadResumable 的 resumeAsync
//   断点记录在 JS 内存里，app 重启即失效。队列会把重启前未完成的 running 任务重新标为
//   pending 并从头重下；TV1 若验证 resumeAsync 可配合持久化 checkpoint 生效，再升级为真续传。
//
// 依赖注入（deps）便于 Node 直测：download / cancel / getFreeDiskBytes / register / now。
// 默认单例绑定真实实现（modelManager + storage）。
//
// 注意：重依赖（modelManager 拉入 expo-file-system、storage/localModels 拉入
// AsyncStorage）一律惰性 require——本模块需在纯 Node 下加载以直测纯函数与注入执行器
// （与 storage/diagnostics.js 同一约定）。

import { rewriteDownloadSourceUrl } from './modelCatalog.js';
import { localModelIdFromFileName } from './modelState.js';

function lazyReadDownloadQueue() {
  return require('../storage/localModels.js').readDownloadQueue();
}

function lazyWriteDownloadQueue(tasks) {
  return require('../storage/localModels.js').writeDownloadQueue(tasks);
}

function lazyDownloadLocalModel(input) {
  return require('./modelManager.js').downloadLocalModel(input);
}

function lazyCancelLocalModelDownload(id) {
  return require('./modelManager.js').cancelLocalModelDownload(id);
}

function lazyGetFreeDiskStorageBytes() {
  return require('./modelManager.js').getFreeDiskStorageBytes();
}

export const DOWNLOAD_TASK_STATUS = {
  PENDING: 'pending',
  RUNNING: 'running',
  ERROR: 'error',
};

// 预检安全余量：预估大小之外再留 5%，覆盖临时文件/元数据/文件系统块对齐。
export const DISK_HEADROOM_RATIO = 1.05;

// 镜像自动回退仅对官方源生效：把 huggingface 改写为国内镜像 hf-mirror。
export const MIRROR_FALLBACK_SOURCE_ID = 'hf-mirror';
export const MIRROR_FALLBACK_FROM = 'huggingface';

// 任务预估总字节：模型本体 + 可选 mmproj 的目录声明大小。任一为 0 则只按已知部分估算；
// 全为 0 时返回 0（调用方据此跳过预检）。
export function estimateTaskBytes(raw = {}) {
  const model = Number(raw.modelExpectedBytes) > 0 ? Number(raw.modelExpectedBytes) : 0;
  const mmproj = Number(raw.mmprojExpectedBytes) > 0 ? Number(raw.mmprojExpectedBytes) : 0;
  return model + mmproj;
}

// 预检判定（纯函数）：freeBytes<=0（拿不到磁盘信息）一律放行，不误伤下载。
export function checkDiskSpace({ freeBytes = 0, requiredBytes = 0, headroomRatio = DISK_HEADROOM_RATIO } = {}) {
  const free = Number(freeBytes);
  const required = Number(requiredBytes);
  if (!Number.isFinite(free) || free <= 0) return { ok: true, reason: '' };
  if (!Number.isFinite(required) || required <= 0) return { ok: true, reason: '' };
  const needed = Math.ceil(required * headroomRatio);
  if (free < needed) return { ok: false, reason: 'insufficient', neededBytes: needed, freeBytes: free };
  return { ok: true, reason: '' };
}

// 镜像回退判定（纯函数）：只有官方源 huggingface 且改写结果有效时给出回退目标。
export function resolveMirrorFallback(task = {}) {
  if (String(task.sourceId || '') !== MIRROR_FALLBACK_FROM) return null;
  const rewritten = rewriteDownloadSourceUrl(task.modelUrl, MIRROR_FALLBACK_SOURCE_ID);
  if (!rewritten || rewritten === task.modelUrl) return null;
  return { modelUrl: rewritten, sourceId: MIRROR_FALLBACK_SOURCE_ID };
}

// 归一化任务：id 由模型标识推导（与 modelManager 下载落点一致），保证同一模型不重复排队。
export function normalizeDownloadTask(raw = {}, timestamp = Date.now()) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const modelUrl = String(source.modelUrl || '').trim();
  const id = String(source.id || '').trim()
    || localModelIdFromFileName(source.modelId || source.name || modelUrl);
  return {
    id,
    modelId: String(source.modelId || id),
    name: String(source.name || source.modelId || id),
    modelUrl,
    sourceId: String(source.sourceId || ''),
    repoPath: String(source.repoPath || ''),
    quant: String(source.quant || ''),
    paramSize: Number(source.paramSize) || 0,
    modelExpectedBytes: Number(source.modelExpectedBytes) || 0,
    modelSha256: String(source.modelSha256 || ''),
    mmprojUrl: String(source.mmprojUrl || ''),
    mmprojExpectedBytes: Number(source.mmprojExpectedBytes) || 0,
    status: source.status === DOWNLOAD_TASK_STATUS.RUNNING || source.status === DOWNLOAD_TASK_STATUS.ERROR
      ? source.status
      : DOWNLOAD_TASK_STATUS.PENDING,
    error: String(source.error || ''),
    createdAt: Number(source.createdAt) || timestamp,
  };
}

// 重启恢复（纯函数）：把崩溃时残留的 running 任务降级为 pending（断点重下）。
export function revivePersistedTasks(tasks = []) {
  return (Array.isArray(tasks) ? tasks : [])
    .map(normalizeDownloadTask)
    .filter(task => task.id && task.modelUrl)
    .map(task => (task.status === DOWNLOAD_TASK_STATUS.RUNNING
      ? { ...task, status: DOWNLOAD_TASK_STATUS.PENDING }
      : task));
}

// 队列执行器工厂：deps 可注入，便于 Node 直测；默认单例绑定真实实现。
export function createDownloadQueue(deps = {}) {
  const load = deps.load || lazyReadDownloadQueue;
  const persist = deps.persist || lazyWriteDownloadQueue;
  const download = deps.download || lazyDownloadLocalModel;
  const cancel = deps.cancel || lazyCancelLocalModelDownload;
  const freeDisk = deps.getFreeDiskBytes || lazyGetFreeDiskStorageBytes;

  let tasks = null;         // null = 未水合
  let running = false;
  let currentTask = null;   // 正在下载的任务（含实时进度）
  const listeners = new Set();

  const emit = () => {
    const snapshot = getSnapshot();
    for (const listener of listeners) {
      try { listener(snapshot); } catch (error) {}
    }
  };

  function getSnapshot() {
    return {
      tasks: tasks ? tasks.map(task => ({ ...task })) : [],
      running: Boolean(currentTask),
      current: currentTask ? { ...currentTask } : null,
    };
  }

  async function hydrate() {
    if (tasks) return tasks;
    const persisted = await load().catch(() => []);
    tasks = revivePersistedTasks(persisted);
    await persist(tasks).catch(() => {});
    // 水合后若还有 pending（重启残留的任务已降级为 pending），自动继续下载。
    if (tasks.some(task => task.status === DOWNLOAD_TASK_STATUS.PENDING)) {
      setTimeout(() => { kick(); }, 0);
    }
    return tasks;
  }

  function findByModelId(modelId) {
    return (tasks || []).find(task => task.id === modelId);
  }

  async function setTasks(next) {
    tasks = next;
    await persist(tasks).catch(() => {});
    emit();
  }

  // 入队：同 id 已存在（pending/running）时不重复入队，避免连点造成双份任务。
  async function enqueue(raw) {
    await hydrate();
    const task = normalizeDownloadTask(raw);
    if (!task.id || !/^https?:\/\//i.test(task.modelUrl)) {
      return { ok: false, code: 'INCOMPLETE_INPUT' };
    }
    if (findByModelId(task.id)) return { ok: true, code: 'DUPLICATE', id: task.id };
    await setTasks([...tasks, task]);
    kick();
    return { ok: true, id: task.id };
  }

  async function removeTask(id, { markError = '' } = {}) {
    await hydrate();
    const index = tasks.findIndex(task => task.id === id);
    if (index < 0) return;
    if (markError) {
      const next = tasks.slice();
      next[index] = { ...next[index], status: DOWNLOAD_TASK_STATUS.ERROR, error: markError };
      await setTasks(next);
      return;
    }
    const next = tasks.slice();
    next.splice(index, 1);
    await setTasks(next);
  }

  async function cancelTask(id) {
    await hydrate();
    const task = findByModelId(id);
    if (!task) return false;
    if (currentTask && currentTask.id === id) {
      await cancel(id).catch(() => false);
      // download 的 catch 会走失败清理由，任务保留为 pending 供重试。
      return true;
    }
    await removeTask(id);
    return true;
  }

  async function runTask(task) {
    const required = estimateTaskBytes(task);
    const free = required > 0 ? await freeDisk().catch(() => 0) : 0;
    const check = checkDiskSpace({ freeBytes: free, requiredBytes: required });
    if (!check.ok) {
      await removeTask(task.id, { markError: 'disk-full' });
      return;
    }

    currentTask = { ...task, status: DOWNLOAD_TASK_STATUS.RUNNING, progress: 0, writtenBytes: 0, totalBytes: required };
    emit();

    const attempt = async input => download({
      ...input,
      onProgress: (progress, info) => {
        currentTask = {
          ...currentTask,
          progress,
          writtenBytes: (info && info.writtenBytes) || 0,
          totalBytes: (info && info.totalBytes) || currentTask.totalBytes,
        };
        emit();
      },
    });

    const baseInput = {
      modelId: task.modelId,
      modelName: task.name,
      modelUrl: task.modelUrl,
      sourceId: task.sourceId,
      repoPath: task.repoPath,
      quant: task.quant,
      paramSize: task.paramSize,
      modelExpectedBytes: task.modelExpectedBytes,
      modelSha256: task.modelSha256,
      mmprojUrl: task.mmprojUrl,
      mmprojExpectedBytes: task.mmprojExpectedBytes,
    };

    try {
      await attempt(baseInput);
      await removeTask(task.id);
    } catch (error) {
      if (error && error.code === 'DOWNLOAD_CANCELLED') {
        // 用户主动取消：任务从队列移除（半成品已由下载失败清理删除）。
        // 自动把取消任务留在 pending 会被 kick 立刻重下，形成取消→重下的死循环。
        await removeTask(task.id);
        return;
      }
      // 官方源失败：自动改写国内镜像续试一次（接线既有 rewriteDownloadSourceUrl）。
      const fallback = resolveMirrorFallback(task);
      if (fallback) {
        try {
          await attempt({ ...baseInput, modelUrl: fallback.modelUrl, sourceId: fallback.sourceId });
          await removeTask(task.id);
          return;
        } catch (fallbackError) {
          await removeTask(task.id, { markError: (fallbackError && fallbackError.message) || 'download-failed' });
          return;
        }
      }
      await removeTask(task.id, { markError: (error && error.message) || 'download-failed' });
    } finally {
      currentTask = null;
      emit();
    }
  }

  // 串行推进：一次只跑一个任务；完成后继续下一个。
  async function kick() {
    if (running) return;
    await hydrate();
    const next = tasks.find(task => task.status === DOWNLOAD_TASK_STATUS.PENDING);
    if (!next) return;
    running = true;
    try {
      await runTask(next);
    } finally {
      running = false;
      // 还有 pending 则继续；用 setTimeout 让出栈，避免深递归。
      if (tasks && tasks.some(task => task.status === DOWNLOAD_TASK_STATUS.PENDING)) {
        setTimeout(() => { kick(); }, 0);
      }
    }
  }

  // 重试失败任务：错误态改回 pending 再 kick。
  async function retry(id) {
    await hydrate();
    const index = tasks.findIndex(task => task.id === id);
    if (index < 0) return { ok: false, code: 'NOT_FOUND' };
    const next = tasks.slice();
    next[index] = { ...next[index], status: DOWNLOAD_TASK_STATUS.PENDING, error: '' };
    await setTasks(next);
    kick();
    return { ok: true };
  }

  return {
    hydrate,
    getSnapshot,
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    enqueue,
    cancelTask,
    retry,
    kick,
    // 仅测试用：清空内存态（不落盘）。
    __reset() { tasks = null; running = false; currentTask = null; listeners.clear(); },
  };
}

// 默认单例：真实实现绑定。
export const downloadQueue = createDownloadQueue();

// 便捷转发（绑定默认单例），供 UI/存储水合路径调用。
export const enqueueDownload = input => downloadQueue.enqueue(input);
export const cancelQueuedDownload = id => downloadQueue.cancelTask(id);
export const retryQueuedDownload = id => downloadQueue.retry(id);
export const getDownloadQueueSnapshot = () => downloadQueue.getSnapshot();
export const hydrateDownloadQueue = () => downloadQueue.hydrate();
export const subscribeDownloadQueue = listener => downloadQueue.subscribe(listener);
