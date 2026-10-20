// 图片下载来源的存储壳（唯一持久化入口）。
//
// 形状：`{ sources: [{ host, referer? }] }`（对象包一层，未来加版本/元数据不用动根结构）。
// 语义见 chat/imageDownloadSources.js 文件头；本文件只负责：
// - 读取状态（损坏时备份原始值并给空名单——**写路径拒绝写回**，避免把用户
//   已配置的来源整表清掉）；
// - 增 / 删 / 清空（串行队列，读-改-写）。
//
// 空名单 = 不限制（旧行为），所以「读到损坏」不会自动变成「限制全部」：
// 读侧回落空名单（行为同旧版），只有写侧拒绝——这个组合最不容易误伤用户。

import {
  MAX_IMAGE_DOWNLOAD_SOURCES,
  normalizeImageSource,
  normalizeImageSources,
} from '../../chat/imageDownloadSources.js';
import { backupCorruptValue, createMutationQueue, readJsonStatus, setJsonRaw } from '../io.js';
import { tActive } from '../../i18n/index.js';

export const IMAGE_DOWNLOAD_SOURCES_KEY = '@easychat2_image_download_sources';

const sourcesMutation = createMutationQueue();

async function readStore() {
  const stored = await readJsonStatus(IMAGE_DOWNLOAD_SOURCES_KEY);
  if (
    stored.status === 'ok'
    && stored.value !== null
    && typeof stored.value === 'object'
    && !Array.isArray(stored.value)
  ) {
    return { status: 'ok', sources: normalizeImageSources(stored.value.sources) };
  }
  if (stored.status === 'missing') return { status: 'missing', sources: [] };
  await backupCorruptValue(IMAGE_DOWNLOAD_SOURCES_KEY);
  return { status: 'corrupt', sources: [] };
}

// 写路径守卫：损坏时整表覆盖会清空用户配置，故拒绝写（原始字节已备份）。
function requireSourcesForMutation(current) {
  if (current.status === 'corrupt') {
    throw new Error(tActive('error.storage.imageDownloadSourcesReadFailed'));
  }
  return current.sources;
}

async function writeStore(sources) {
  await setJsonRaw(IMAGE_DOWNLOAD_SOURCES_KEY, { sources: normalizeImageSources(sources) });
}

// 读侧：损坏/异常一律回落空名单（= 不限制，行为与旧版一致）。
export async function getImageDownloadSources() {
  try {
    return (await readStore()).sources;
  } catch (error) {
    return [];
  }
}

// 设置页展示用：条数 + 损坏标记（不谎报「0 条」）。
export async function getImageDownloadSourcesStatus() {
  try {
    const current = await readStore();
    return { sources: current.sources, corrupt: current.status === 'corrupt' };
  } catch (error) {
    return { sources: [], corrupt: false };
  }
}

// 新增（同主机视为更新：用新条目覆盖旧的引用页）。
// 非法输入 → null；超上限 → 抛带 code 的 Error（UI 据此显示具体文案）。
export function addImageDownloadSource(raw) {
  const source = normalizeImageSource(raw);
  if (!source) return Promise.resolve(null);
  return sourcesMutation.enqueue(async () => {
    const current = requireSourcesForMutation(await readStore());
    const exists = current.some(item => item.host === source.host);
    if (!exists && current.length >= MAX_IMAGE_DOWNLOAD_SOURCES) {
      const error = new Error(tActive('error.storage.imageDownloadSourcesTooMany'));
      error.code = 'IMAGE_SOURCE_LIMIT';
      throw error;
    }
    await writeStore([source, ...current.filter(item => item.host !== source.host)]);
    return source;
  });
}

export function removeImageDownloadSource(host) {
  const source = normalizeImageSource({ host });
  if (!source) return Promise.resolve(false);
  return sourcesMutation.enqueue(async () => {
    const current = requireSourcesForMutation(await readStore());
    const next = current.filter(item => item.host !== source.host);
    if (next.length === current.length) return false;
    await writeStore(next);
    return true;
  });
}

export function clearImageDownloadSources() {
  return sourcesMutation.enqueue(async () => {
    requireSourcesForMutation(await readStore());
    await writeStore([]);
    return true;
  });
}

// 供「清空全部」以外的内部场景（测试/迁移）直接读原始键的键名。
export const IMAGE_DOWNLOAD_SOURCES_STORAGE_KEY = IMAGE_DOWNLOAD_SOURCES_KEY;
