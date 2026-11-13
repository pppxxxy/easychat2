// AsyncStorage 适配（design.md「适配层契约 1」）：键值语义与现有存储层完全一致。
// 真实落盘在主进程（kv 仓：一键一文件 + 原子重命名）；这里只做通道映射。
import { createLazyDefault } from './bridge.js';

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

export default createLazyDefault(createAsyncStorage);
