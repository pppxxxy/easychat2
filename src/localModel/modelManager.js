// 本地模型文件生命周期：下载、本地导入、文件信息与删除。
// 原生模型只接收 documentDirectory 下的本地路径；下载/导入任一步失败都清理半成品文件并回滚登记。
// 文件系统与登记依赖可注入（options.fileSystem / options.registerItem），便于 Node 单测。

import * as FileSystem from 'expo-file-system/legacy';

import { saveLocalModelItem } from '../storage/localModels.js';
import {
  buildLocalModelItem,
  localModelIdFromFileName,
  localModelPath as safeLocalModelPath,
} from './modelState.js';
import { formatBytes } from './modelLogs.js';

export const LOCAL_MODEL_DIRECTORY = 'local-models';

// 下载完整性「强校验」：只比字节数（并非哈希）。
// sha256 需要原生或分块哈希能力（当前无），但「HTTP 200 + 落盘大小 == 目录声明大小」
// 足以挡住绝大多数「网络在 95% 断流 / 镜像返回截断文件却被登记为合法模型」的情况。
// expectedBytes<=0（目录未声明大小）时不做判断，避免误伤。纯函数，便于单测。
export function verifyDownloadedSize(actualBytes, expectedBytes) {
  const actual = Math.max(0, Math.floor(Number(actualBytes) || 0));
  const expected = Math.floor(Number(expectedBytes) || 0);
  if (expected <= 0) return { ok: true, reason: '' };
  if (actual === expected) return { ok: true, reason: '' };
  return {
    ok: false,
    reason: `下载不完整（预期 ${formatBytes(expected)}，实际 ${formatBytes(actual)}），已自动清理，请重试`,
  };
}

export function localModelDirectory() {
  return `${FileSystem.documentDirectory || FileSystem.cacheDirectory || ''}${LOCAL_MODEL_DIRECTORY}/`;
}

export function localModelPath(modelId, extension = 'gguf') {
  return `${localModelDirectory()}${safeLocalModelPath(modelId, extension)}`;
}

export function localModelMmprojPath(modelId) {
  return localModelPath(modelId, 'mmproj.gguf');
}

function resolveFileSystem(options) {
  return (options && options.fileSystem) || FileSystem;
}

function resolveRegister(options) {
  return (options && options.registerItem) || saveLocalModelItem;
}

function parsePositiveSize(info) {
  const size = Number(info && info.size);
  return Number.isFinite(size) && size > 0 ? Math.floor(size) : 0;
}

async function removeQuietly(fs, path) {
  if (!path) return;
  try {
    await fs.deleteAsync(path, { idempotent: true });
  } catch (error) {}
}

export async function getLocalModelFileInfo(model, options = {}) {
  const fs = resolveFileSystem(options);
  const path = String((model && model.modelPath) || '').trim();
  if (!path) return { exists: false };
  return fs.getInfoAsync(path);
}

// 原子替换：旧文件先挪到 .old 备份，新文件就位后才清备份；替换失败时恢复旧文件。
// 否则「先删旧再写新」的窗口里 move/copy 一失败，旧模型也会一起丢。
async function swapIntoPlace(fs, source, destination) {
  const backup = `${destination}.old`;
  await removeQuietly(fs, backup);
  let replaced = false;
  try {
    const existing = await fs.getInfoAsync(destination);
    if (existing && existing.exists) {
      await fs.moveAsync({ from: destination, to: backup });
      replaced = true;
    }
    await fs.moveAsync({ from: source, to: destination });
    await removeQuietly(fs, backup);
  } catch (error) {
    if (replaced) {
      await removeQuietly(fs, destination);
      await fs.moveAsync({ from: backup, to: destination }).catch(() => {});
    }
    throw error;
  }
}

async function downloadToFile(fs, url, destination, onProgress, expectedBytes = 0) {
  const temporary = `${destination}.download`;
  await fs.makeDirectoryAsync(localModelDirectory(), { intermediates: true });
  await removeQuietly(fs, temporary);
  try {
    // Content-Length（totalBytesExpectedToWrite）也留一份：即便调用方没传目录声明大小，
    // 也能在断流时用「服务端声明的总长」兜底校验。
    let contentLength = 0;
    const task = fs.createDownloadResumable(url, temporary, {}, progress => {
      const total = Number(progress.totalBytesExpectedToWrite);
      if (Number.isFinite(total) && total > 0) contentLength = total;
      if (typeof onProgress !== 'function') return;
      const written = Number(progress.totalBytesWritten);
      onProgress(total > 0 ? Math.min(1, written / total) : 0);
    });
    const result = await task.downloadAsync();
    if (!result || !result.uri) throw new Error('模型下载失败');
    // 404/403 的错误页会被完整写成文件，必须在落位前按状态码拒绝。
    const status = Number(result.status);
    if (Number.isFinite(status) && status >= 400) throw new Error(`模型下载失败（HTTP ${status}）`);
    const info = await fs.getInfoAsync(result.uri);
    const size = parsePositiveSize(info);
    if (!info || info.exists === false || size <= 0) throw new Error('模型文件为空');
    // 大小强校验：优先用目录声明的字节数，缺省用 Content-Length 兜底，拦截截断的下载。
    const expected = Number(expectedBytes) > 0 ? Number(expectedBytes) : contentLength;
    const check = verifyDownloadedSize(size, expected);
    if (!check.ok) {
      const error = new Error(check.reason);
      error.code = 'INCOMPLETE_DOWNLOAD';
      throw error;
    }
    await swapIntoPlace(fs, result.uri, destination);
    return size;
  } catch (error) {
    await removeQuietly(fs, temporary);
    throw error;
  }
}

async function copyToFile(fs, sourceUri, destination) {
  const staging = `${destination}.import`;
  await fs.makeDirectoryAsync(localModelDirectory(), { intermediates: true });
  await removeQuietly(fs, staging);
  try {
    const info = await fs.getInfoAsync(sourceUri);
    const size = parsePositiveSize(info);
    if (!info || info.exists === false || size <= 0) throw new Error('所选文件为空');
    await fs.copyAsync({ from: sourceUri, to: staging });
    await swapIntoPlace(fs, staging, destination);
    return size;
  } catch (error) {
    await removeQuietly(fs, staging);
    throw error;
  }
}

// 下载模型（可选配套 mmproj）→ 构造条目 → 登记索引。
// 下载或登记任一步失败，删除已落盘文件并把错误抛给调用方。
export async function downloadLocalModel(input = {}, options = {}) {
  const fs = resolveFileSystem(options);
  const register = resolveRegister(options);
  const url = String(input.modelUrl || '').trim();
  const id = localModelIdFromFileName(input.modelId || input.modelName || input.modelUrl);
  if (!id || !/^https?:\/\//i.test(url)) throw new Error('请填写有效的模型地址与模型 id');
  const destination = localModelPath(id);
  const mmprojUrl = String(input.mmprojUrl || '').trim();
  const mmprojDestination = mmprojUrl ? localModelMmprojPath(id) : '';
  let modelWritten = false;
  let mmprojWritten = false;
  try {
    const modelBytes = await downloadToFile(fs, url, destination, input.onProgress, input.modelExpectedBytes);
    modelWritten = true;
    let mmprojBytes = 0;
    if (mmprojUrl) {
      mmprojBytes = await downloadToFile(fs, mmprojUrl, mmprojDestination, null, input.mmprojExpectedBytes);
      mmprojWritten = true;
    }
    const item = buildLocalModelItem({
      id,
      name: input.modelName || id,
      sourceId: input.sourceId,
      repoPath: input.repoPath,
      modelUrl: url,
      modelPath: destination,
      modelBytes,
      modelSha256: input.modelSha256,
      quant: input.quant,
      paramSize: input.paramSize,
      mmprojUrl,
      mmprojPath: mmprojDestination,
      mmprojBytes,
      imported: false,
    });
    return await register(item);
  } catch (error) {
    if (modelWritten) await removeQuietly(fs, destination);
    if (mmprojWritten) await removeQuietly(fs, mmprojDestination);
    throw error;
  }
}

// 导入本地 GGUF（可选配套 mmproj）：复制进应用目录 → 构造 imported 条目 → 登记索引。
export async function importLocalModel(input = {}, options = {}) {
  const fs = resolveFileSystem(options);
  const register = resolveRegister(options);
  const sourceUri = String(input.sourceUri || '').trim();
  const id = localModelIdFromFileName(input.modelId || input.sourceUri || input.name);
  if (!sourceUri || !id) throw new Error('请选择要导入的 GGUF 文件');
  const destination = localModelPath(id);
  const mmprojSourceUri = String(input.mmprojSourceUri || '').trim();
  const mmprojDestination = mmprojSourceUri ? localModelMmprojPath(id) : '';
  let modelWritten = false;
  let mmprojWritten = false;
  try {
    const modelBytes = await copyToFile(fs, sourceUri, destination);
    modelWritten = true;
    let mmprojBytes = 0;
    if (mmprojSourceUri) {
      mmprojBytes = await copyToFile(fs, mmprojSourceUri, mmprojDestination);
      mmprojWritten = true;
    }
    const item = buildLocalModelItem({
      id,
      name: input.name || id,
      sourceId: 'local',
      modelUrl: '',
      modelPath: destination,
      modelBytes,
      quant: input.quant,
      paramSize: input.paramSize,
      mmprojPath: mmprojDestination,
      mmprojBytes,
      imported: true,
    });
    return await register(item);
  } catch (error) {
    if (modelWritten) await removeQuietly(fs, destination);
    if (mmprojWritten) await removeQuietly(fs, mmprojDestination);
    throw error;
  }
}

// 删除模型文件与配套 mmproj；文件缺失不报错（幂等）。
export async function deleteLocalModel(model, options = {}) {
  const fs = resolveFileSystem(options);
  if (!model) return;
  await removeQuietly(fs, model.modelPath);
  await removeQuietly(fs, model.mmprojPath);
}

// 下载/导入的中间产物后缀：正常完成会被 swap 清理，但应用被杀（下载中来电、系统杀进程）
// 会留下 .download/.old/.import 残留，数 GB 隐形占用且不被索引看见。
export function isOrphanLocalModelTempFile(name) {
  return /\.(download|old|import)$/.test(String(name || ''));
}

// 扫描 local-models/ 目录，删除所有中间产物残留，返回释放的字节数。
// 只删这些后缀的文件，注册的 .gguf 绝不会命中（文件名不以这些后缀结尾）。
export async function cleanupOrphanLocalModelFiles(options = {}) {
  const fs = resolveFileSystem(options);
  const dir = localModelDirectory();
  let names = [];
  try {
    names = await fs.readDirectoryAsync(dir);
  } catch (error) {
    return { removed: 0, freedBytes: 0 };
  }
  const orphans = (Array.isArray(names) ? names : []).filter(isOrphanLocalModelTempFile);
  let freedBytes = 0;
  let removed = 0;
  for (const name of orphans) {
    const path = `${dir}${name}`;
    try {
      const info = await fs.getInfoAsync(path);
      freedBytes += parsePositiveSize(info);
      await fs.deleteAsync(path, { idempotent: true });
      removed += 1;
    } catch (error) {}
  }
  return { removed, freedBytes };
}
