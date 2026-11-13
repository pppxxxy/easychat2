// 桌面桥（window.easychat2，由 preload 经 contextBridge 注入）。
//
// 适配层统一从 getBridge() 取通道；Node 测试注入假桥（见 desktop/tests/helpers）。
// createLazyDefault：模块级默认导出的「惰性实例」——共享层 import 时只拿到 Proxy，
// 首次调用才解析 window.easychat2。这样 Node 里 import 适配层不会因为缺 window 炸掉，
// 而 Vite 构建期也不会执行任何真实 IPC。
export function getBridge() {
  const bridge = typeof globalThis !== 'undefined' ? globalThis.easychat2 : undefined;
  if (!bridge) {
    const error = new Error('desktop bridge unavailable: preload did not expose window.easychat2');
    error.code = 'BRIDGE_UNAVAILABLE';
    throw error;
  }
  return bridge;
}

export function createLazyDefault(factory) {
  let instance = null;
  const ensure = () => {
    if (!instance) instance = factory(getBridge());
    return instance;
  };
  return new Proxy({}, {
    get(target, property) {
      const value = ensure()[property];
      return typeof value === 'function' ? value.bind(instance) : value;
    },
    has(target, property) {
      return property in ensure();
    },
    ownKeys() {
      return Reflect.ownKeys(ensure());
    },
    getOwnPropertyDescriptor(target, property) {
      return Reflect.getOwnPropertyDescriptor(ensure(), property);
    },
  });
}
