// 桌面首版未实现能力的统一错误（design.md「首版能力降级」）。
// 结构化 code 供上层识别；message 用英文（避免进入 no-hardcoded-chinese 规则范围）。
export function unsupportedCapability(name) {
  const error = new Error(`${name} is not available on desktop in this release`);
  error.code = 'CAPABILITY_UNAVAILABLE';
  return error;
}

export function makeUnsupportedModule(name, methods) {
  const module = {};
  for (const method of methods) {
    module[method] = async () => {
      throw unsupportedCapability(`${name}.${method}`);
    };
  }
  return module;
}
