// expo-secure-store 适配（design.md「适配层契约 3」）：四个方法的形状与 expo 一致。
// 真实加密在主进程（safeStorage / DPAPI）；`secure:v1:<id>` 引用格式由共享层维护，
// 这里只是按 id 存取。
import { createLazyDefault } from './bridge.js';

export function createSecureStore(bridge) {
  const secret = bridge.secret;
  return {
    isAvailableAsync: () => secret.available(),
    getItemAsync: id => secret.get(String(id)),
    setItemAsync: (id, value) => secret.set(String(id), String(value)),
    deleteItemAsync: id => secret.remove(String(id)),
  };
}

export default createLazyDefault(createSecureStore);
