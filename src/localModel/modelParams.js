// 本地模型推理参数：每个模型一套，纯函数，不依赖 RN/Expo，便于单测。
// 参数随模型条目一起存储；删除模型即级联删除其参数（同一 item 键）。

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
