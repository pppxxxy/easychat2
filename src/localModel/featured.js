// 精选模型目录（v5 Stage E）：面向小尺寸、能在多数手机上稳跑的 GGUF 仓库，
// 给「获取」页顶部一组直达入口，降低新用户面对空白搜索框的茫然。
//
// 精选条目是**已知可用的仓库坐标**（不是硬编码下载 URL）：点击后仍走 modelCatalog
// 的仓库文件列表（列文件 → 兼容分级 → 选量化），保证量化/体积/兼容信息实时准确。
// 全部为纯数据 + 纯函数，便于 Node 直测。

import { LOCAL_MODEL_DOWNLOAD_SOURCES } from './modelState.js';

// 精选条目：repoId 用各源的仓库坐标（HuggingFace 风格 owner/repo）。
// sizeTier 为粗略参数规模档（B），minMemoryBytes 为该仓库最小量化大致需求，
// 用于按设备内存过滤/排序——真值仍在文件层按实际 GGUF 计算。
export const FEATURED_MODELS = [
  {
    id: 'qwen3-1.7b',
    name: 'Qwen3 1.7B',
    repoId: 'Qwen/Qwen3-1.7B-GGUF',
    paramSize: 1.7,
    minMemoryBytes: 1.6 * 1024 * 1024 * 1024,
    noteKey: 'localModel.featured.note.light',
  },
  {
    id: 'qwen3-4b',
    name: 'Qwen3 4B',
    repoId: 'Qwen/Qwen3-4B-GGUF',
    paramSize: 4,
    minMemoryBytes: 3.2 * 1024 * 1024 * 1024,
    noteKey: 'localModel.featured.note.balanced',
  },
  {
    id: 'gemma3-4b',
    name: 'Gemma 3 4B',
    repoId: 'unsloth/gemma-3-4b-it-GGUF',
    paramSize: 4,
    minMemoryBytes: 3.2 * 1024 * 1024 * 1024,
    noteKey: 'localModel.featured.note.multimodal',
  },
  {
    id: 'lfm2-1.2b',
    name: 'LFM2 1.2B',
    repoId: 'LiquidAI/LFM2-1.2B-GGUF',
    paramSize: 1.2,
    minMemoryBytes: 1.2 * 1024 * 1024 * 1024,
    noteKey: 'localModel.featured.note.light',
  },
];

// 设备可用预算：与兼容分级同为总内存的 60%（DEVICE_USABLE_MEMORY_RATIO），
// 保持「精选里出现 = 至少难跑档能跑」的一致口径。
export const FEATURED_USABLE_RATIO = 0.6;

export function isFeaturedSourceAvailable(sourceId) {
  return LOCAL_MODEL_DOWNLOAD_SOURCES.some(source => source.id === sourceId);
}

// 按设备内存挑选精选：内存未知（0）时全部保留（不让缺信息把入口清空）；
// 已知内存时过滤掉「超出可用预算」的条目，并按体积从小到大排序（小模型优先）。
export function selectFeaturedModels({ totalMemoryBytes = 0, sourceId = 'huggingface' } = {}) {
  const total = Number(totalMemoryBytes);
  const list = FEATURED_MODELS.map(item => ({
    ...item,
    sourceId,
    memoryKnown: Number.isFinite(total) && total > 0,
    fits: !(Number.isFinite(total) && total > 0) || item.minMemoryBytes <= total * FEATURED_USABLE_RATIO,
  }));
  if (!Number.isFinite(total) || total <= 0) return list;
  return list
    .filter(item => item.fits)
    .sort((a, b) => a.minMemoryBytes - b.minMemoryBytes);
}
