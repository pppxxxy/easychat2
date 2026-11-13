// AsyncStorage 适配（design.md「适配层契约 1」）：键值语义与现有存储层完全一致。
// 真实落盘在主进程（kv 仓：一键一文件 + 原子重命名）；这里只做通道映射。
// 共享层用默认导入（`import AsyncStorage from ...`），同时提供命名导出兜底 * 导入。
export function createAsyncStorage(bridge) {
  const kv = bridge.kv;
  return {
    getItem: key => kv.get(String(key)),
    setItem: (key, value) => kv.set(String(key), String(value)),
    removeItem: key => kv.remove(String(key)),
    getAllKeys: () => kv.keys(),
    multiGet: keys => kv.multiGet((keys || []).map(String)),
    multiSet: entries => kv.multiSet((entries || []).map(([key, value]) => [String(key), String(value)])),
    multiRemove: keys => kv.multiRemove((keys || []).map(String)),
  };
}

const bridge = typeof globalThis !== 'undefined' ? globalThis.easychat2 : null;
const instance = bridge ? createAsyncStorage(bridge) : null;
const ensure = () => {
  if (!instance) throw new Error('desktop bridge unavailable');
  return instance;
};

export const getItem = (...args) => ensure().getItem(...args);
export const setItem = (...args) => ensure().setItem(...args);
export const removeItem = (...args) => ensure().removeItem(...args);
export const getAllKeys = (...args) => ensure().getAllKeys(...args);
export const multiGet = (...args) => ensure().multiGet(...args);
export const multiSet = (...args) => ensure().multiSet(...args);
export const multiRemove = (...args) => ensure().multiRemove(...args);

export default instance || {
  getItem, setItem, removeItem, getAllKeys, multiGet, multiSet, multiRemove,
};
