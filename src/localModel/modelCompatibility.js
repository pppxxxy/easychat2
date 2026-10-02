// 本地模型量化解析、内存占用估算与兼容分级。
// 全部为纯函数，便于单测；设备内存读取在 deviceMemory.js（含原生依赖）。

// 常见 GGUF 量化及每权重平均比特数（含 scale/元数据开销的近似值）。
const QUANT_BITS = {
  IQ1_S: 1.56,
  IQ1_M: 1.75,
  IQ2_XXS: 2.06,
  IQ2_XS: 2.31,
  IQ2_S: 2.5,
  IQ2_M: 2.7,
  Q2_K_S: 2.6,
  Q2_K: 2.63,
  IQ3_XXS: 3.06,
  IQ3_XS: 3.3,
  IQ3_S: 3.44,
  IQ3_M: 3.66,
  Q3_K_S: 3.5,
  Q3_K_M: 3.91,
  Q3_K_L: 4.27,
  Q3_K: 3.44,
  IQ4_XS: 4.25,
  IQ4_NL: 4.5,
  Q4_K_S: 4.58,
  Q4_K_M: 4.85,
  Q4_K: 4.5,
  Q4_0: 4.55,
  Q4_1: 4.7,
  Q5_K_S: 5.52,
  Q5_K_M: 5.67,
  Q5_K: 5.5,
  Q5_0: 5.54,
  Q5_1: 5.7,
  Q6_K: 6.56,
  Q8_0: 8.5,
  F16: 16,
  FP16: 16,
  BF16: 16,
  F32: 32,
  FP32: 32,
};

// 长 token 优先，避免 Q4_K 抢先匹配 Q4_K_M。
const QUANT_TOKENS = Object.keys(QUANT_BITS).sort((a, b) => b.length - a.length);

function normalizeToken(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9_]/g, '');
}

// 从文件名/名称中解析量化等级，返回 { label, bitsPerWeight, family } 或 null。
export function parseQuantization(value) {
  if (!value) return null;
  const normalized = normalizeToken(value);
  if (!normalized) return null;
  const collapsed = normalized.replace(/_/g, '');
  for (const token of QUANT_TOKENS) {
    if (normalized.includes(token) || collapsed.includes(token.replace(/_/g, ''))) {
      return {
        label: token,
        bitsPerWeight: QUANT_BITS[token],
        family: token.startsWith('IQ') ? 'IQ' : token.startsWith('Q') ? 'Q' : 'F',
      };
    }
  }
  return null;
}

// 从名称中解析参数规模（十亿参数），如 1.5B → 1.5；无法识别返回 0。
export function parseParamScaleB(value) {
  const text = String(value || '');
  const match = text.match(/(\d+(?:[._]\d+)?)\s*[bB](?![a-zA-Z0-9])/);
  if (!match) return 0;
  const number = Number(match[1].replace('_', '.'));
  return Number.isFinite(number) && number > 0 ? number : 0;
}

const KV_BYTES_PER_BILLION_PER_TOKEN = 16 * 1024; // f16 KV 的粗略下界
const RUNTIME_OVERHEAD_BYTES = 200 * 1024 * 1024;
const WEIGHT_OVERHEAD_RATIO = 0.08;

function toNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

// 估算运行所需内存：权重 + KV cache + 运行时开销（近似值，用于兼容提示）。
export function estimateModelMemory({ paramBillion = 0, bitsPerWeight = 0, contextSize = 2048 } = {}) {
  const params = toNonNegative(paramBillion);
  const bits = toNonNegative(bitsPerWeight);
  const context = toNonNegative(contextSize);
  const weightsBytes = Math.round((params * 1e9 * bits) / 8);
  const kvBytes = params > 0 && context > 0
    ? Math.round(params * context * KV_BYTES_PER_BILLION_PER_TOKEN)
    : 0;
  const overheadBytes = weightsBytes > 0
    ? Math.round(RUNTIME_OVERHEAD_BYTES + weightsBytes * WEIGHT_OVERHEAD_RATIO)
    : 0;
  return {
    weightsBytes,
    kvBytes,
    overheadBytes,
    totalBytes: weightsBytes + kvBytes + overheadBytes,
  };
}

// 可用内存预算：设备总内存预留系统与自身占用后的部分。
export const DEVICE_USABLE_MEMORY_RATIO = 0.6;
export const RECOMMENDED_MEMORY_RATIO = 0.8;

// 兼容分级：跑不了 / 难跑 / 推荐；缺内存信息时返回 unknown。
export function classifyModelMemory(requiredBytes, { totalMemoryBytes = 0 } = {}) {
  const required = toNonNegative(requiredBytes);
  const total = toNonNegative(totalMemoryBytes);
  if (!required || !total) {
    return { tier: 'unknown', label: '内存未知', budgetBytes: 0 };
  }
  const budgetBytes = Math.round(total * DEVICE_USABLE_MEMORY_RATIO);
  if (required > budgetBytes) {
    return { tier: 'incompatible', label: '跑不了', budgetBytes };
  }
  if (required > budgetBytes * RECOMMENDED_MEMORY_RATIO) {
    return { tier: 'tight', label: '难跑', budgetBytes };
  }
  return { tier: 'recommended', label: '推荐', budgetBytes };
}

// 汇总展示信息：量化、参数规模、内存占用与兼容分级。
export function buildModelSummary(
  { name = '', quant = '', paramSize = 0 } = {},
  { totalMemoryBytes = 0, contextSize = 2048 } = {}
) {
  const parsedQuant = parseQuantization(quant) || parseQuantization(name);
  const parsedParam = toNonNegative(paramSize) || parseParamScaleB(name) || parseParamScaleB(quant);
  const memory = parsedQuant && parsedParam
    ? estimateModelMemory({
      paramBillion: parsedParam,
      bitsPerWeight: parsedQuant.bitsPerWeight,
      contextSize,
    })
    : { weightsBytes: 0, kvBytes: 0, overheadBytes: 0, totalBytes: 0 };
  const compatibility = classifyModelMemory(memory.totalBytes, { totalMemoryBytes });
  return {
    quantLabel: parsedQuant ? parsedQuant.label : '',
    bitsPerWeight: parsedQuant ? parsedQuant.bitsPerWeight : 0,
    paramLabel: parsedParam > 0 ? `${parsedParam}B` : '',
    paramSize: parsedParam,
    memory,
    compatibility,
  };
}

const TIER_RANK = { recommended: 0, tight: 1, unknown: 2, incompatible: 3 };

// 为每个量化文件附上兼容摘要并按推荐程度排序：推荐（绰绰有余）在前、跑不了沉底，
// 同级别按文件体积升序（更小更稳）。filenames 已含参数规模与量化等级（如
// `Qwen2.5-3B-Instruct-Q4_K_M.gguf`），故直接由文件名解析，无需额外元数据。
export function rankModelFiles(files, { totalMemoryBytes = 0, contextSize = 2048 } = {}) {
  const list = Array.isArray(files) ? files : [];
  return list
    .map(file => {
      const rawName = String((file && file.path) || '');
      const base = rawName.split('/').pop().replace(/\.gguf$/i, '');
      return {
        file,
        summary: buildModelSummary({ name: base }, { totalMemoryBytes, contextSize }),
      };
    })
    .sort((a, b) => {
      const rankA = TIER_RANK[a.summary.compatibility.tier] ?? 2;
      const rankB = TIER_RANK[b.summary.compatibility.tier] ?? 2;
      if (rankA !== rankB) return rankA - rankB;
      const sizeA = toNonNegative(a.file && a.file.size);
      const sizeB = toNonNegative(b.file && b.file.size);
      return sizeA - sizeB;
    });
}
