// `src/context/AppContext.js` 的 Provider 桩（供渲染测试用）。
//
// 为什么需要：FilesPanel 的挂载 effect 会调 refreshAppData()，而真实的 AppContext
// 为了加载角色/会话/设置，会把整条原生存储栈（AsyncStorage + FileSystem + SecureStore
// + SQLite，9 个设置子模块）拖进进程。渲染测试只需要「这个 hook 能拿到一个函数」。
//
// 与 theme/i18n 两个桩同一思路：**只切断副作用，不改行为契约**——
// 这里提供的 refreshAppData 是一个真实的 async 函数（可被断言调用次数），
// 不是返回假数据的 mock 值。
//
// 纪律：未提供的字段一律显式抛错，避免「用了不存在的字段却静默 undefined」。

export const appCalls = [];

const notProvided = name => {
  throw new Error(
    `AppContext 桩：${name} 未提供（渲染测试只实现被用到的字段；`
    + '若被测组件需要它，请在此显式补上，不要让它静默 undefined）'
  );
};

export function useApp() {
  return {
    refreshAppData: async () => {
      appCalls.push(['refreshAppData']);
    },
    // 只声明「已知但本测试不需要」的字段为显式抛错，避免误用。
    isCurrentSession: () => notProvided('isCurrentSession'),
  };
}

export function useAppOptional() {
  return useApp();
}

// 组件测试不渲染 Provider（没有组件树需要它）；保留同名导出以免 import 失败。
export function AppProvider({ children }) {
  return children;
}

export default { useApp, AppProvider, useAppOptional };
