// expo-secure-store 适配（design.md「适配层契约 3」）：四个方法的形状与 expo 一致。
//
// 两种消费方式都要覆盖：
//   · storage/secretStore.js 的惰性 `require('expo-secure-store')`（由 polyfills 的
//     require 桥映射到本模块的 default 实例）；
//   · 共享层（或未来桌面代码）的命名导入。
export function createSecureStore(bridge) {
  const secret = bridge.secret;
  return {
    isAvailableAsync: () => secret.available(),
    getItemAsync: id => secret.get(String(id)),
    setItemAsync: (id, value) => secret.set(String(id), String(value)),
    deleteItemAsync: id => secret.remove(String(id)),
  };
}

const bridge = typeof globalThis !== 'undefined' ? globalThis.easychat2 : null;
const instance = bridge ? createSecureStore(bridge) : null;
const ensure = () => {
  if (!instance) throw new Error('desktop bridge unavailable');
  return instance;
};

export const isAvailableAsync = (...args) => ensure().isAvailableAsync(...args);
export const getItemAsync = (...args) => ensure().getItemAsync(...args);
export const setItemAsync = (...args) => ensure().setItemAsync(...args);
export const deleteItemAsync = (...args) => ensure().deleteItemAsync(...args);

export default instance || { isAvailableAsync, getItemAsync, setItemAsync, deleteItemAsync };
