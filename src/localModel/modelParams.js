// 本地模型推理参数：每个模型一套，纯函数，不依赖 RN/Expo，便于单测。
// 参数随模型条目一起存储；删除模型即级联删除其参数（同一 item 键）。

import { estimateModelMemory } from './modelCompatibility.js';

export const LOCAL_MODEL_PARAM_FIELDS = {
  contextSize: { min: 512, max: 131072, integer: true, default: 2048 },
  gpuLayers: { min: 0, max: 999, integer: true, default: 0 },
  // 0 表示交给运行时自动决定线程数。
  threads: { min: 0, max: 16, integer: true, default: 0 },
  temperature: { min: 0, max: 2, integer: false, default: 1 },
  topP: { min: 0, max: 1, integer: false, default: 1 },
  topK: { min: 0, max: 100, integer: true, default: 0 },
  // -1 表示不限制生成长度（跟随上下文）。
  maxTokens: { min: -1, max: 32768, integer: true, default: 512 },
};

export const DEFAULT_LOCAL_MODEL_PARAMS = {
  contextSize: 2048,
  gpuLayers: 0,
  threads: 0,
  temperature: 1,
  topP: 1,
  topK: 0,
  maxTokens: 512,
};

// 参数预设（v5 Stage C）：面向常见用途的一组起点，避免用户面对 7 个裸数字字段。
// 预设只覆盖采样相关字段；contextSize/gpuLayers/threads 等与设备相关的字段不动，
// 由用户在「高级」里按机型调整（contextSize 变更会即时显示内存影响）。
export const LOCAL_MODEL_PARAM_PRESETS = [
  { id: 'chat', labelKey: 'localModel.params.preset.chat', params: { temperature: 0.9, topP: 0.95, topK: 40, maxTokens: 512 } },
  { id: 'writing', labelKey: 'localModel.params.preset.writing', params: { temperature: 1.1, topP: 0.95, topK: 60, maxTokens: 1024 } },
  { id: 'code', labelKey: 'localModel.params.preset.code', params: { temperature: 0.3, topP: 0.9, topK: 20, maxTokens: 1024 } },
];

// 应用预设：在现有参数上覆盖预设字段，返回归一化结果（非法值自动夹取）。
export function applyLocalModelParamPreset(current, presetId) {
  const preset = LOCAL_MODEL_PARAM_PRESETS.find(item => item.id === presetId);
  const base = normalizeLocalModelParams(current);
  if (!preset) return base;
  return normalizeLocalModelParams({ ...base, ...preset.params });
}

// contextSize 变更的内存影响（纯函数，复用 modelCompatibility.estimateModelMemory）：
// 供参数弹窗即时显示「上下文越大，KV 占用越大」的代价，教用户权衡。
export function contextSizeMemoryDelta({ paramBillion = 0, bitsPerWeight = 0, from = 0, to = 0 } = {}) {
  const before = estimateModelMemory({ paramBillion, bitsPerWeight, contextSize: from });
  const after = estimateModelMemory({ paramBillion, bitsPerWeight, contextSize: to });
  return {
    beforeBytes: before.kvBytes,
    afterBytes: after.kvBytes,
    deltaBytes: after.kvBytes - before.kvBytes,
  };
}

function clampLocalModelParam(name, raw) {
  const rule = LOCAL_MODEL_PARAM_FIELDS[name];
  const isEmpty = raw === '' || raw === null || raw === undefined;
  const parsed = isEmpty ? NaN : Number(raw);
  let value = Number.isFinite(parsed) ? parsed : rule.default;
  if (rule.integer) value = Math.round(value);
  return Math.min(rule.max, Math.max(rule.min, value));
}

export function normalizeLocalModelParams(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const result = {};
  Object.keys(LOCAL_MODEL_PARAM_FIELDS).forEach(name => {
    result[name] = clampLocalModelParam(name, source[name]);
  });
  return result;
}

// 单字段即时校验（U7 越界红框用）：空值 = 用默认，放过；返回稳定 code 供界面映射文案。
export function checkLocalModelParamField(name, raw) {
  const rule = LOCAL_MODEL_PARAM_FIELDS[name];
  if (!rule) return { ok: true, code: '' };
  if (raw === '' || raw === null || raw === undefined) return { ok: true, code: '' };
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return { ok: false, code: 'NOT_NUMBER' };
  if (parsed < rule.min || parsed > rule.max) return { ok: false, code: 'OUT_OF_RANGE' };
  return { ok: true, code: '' };
}

// 表单校验：空值按「用默认」放过；非数字或越界给出可见错误。
export function validateLocalModelParams(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const errors = [];
  Object.keys(LOCAL_MODEL_PARAM_FIELDS).forEach(name => {
    const rule = LOCAL_MODEL_PARAM_FIELDS[name];
    const value = source[name];
    if (value === '' || value === null || value === undefined) return;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      errors.push({ field: name, message: '需要是数字' });
      return;
    }
    if (parsed < rule.min || parsed > rule.max) {
      errors.push({ field: name, message: `需在 ${rule.min}–${rule.max} 之间` });
    }
  });
  return { valid: errors.length === 0, errors };
}
