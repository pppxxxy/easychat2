// `src/workspace/native.js` 的桩（供 FilesPanel 渲染测试）。
//
// 真实模块会构建基于 expo-file-system 的 store。渲染测试只需要一个**目录树可控**的
// 内存后端，用来观察「下钻时请求了哪一层」。
//
// 目录树（与 spec 一致，模拟用户报告的场景）：
//   ''                      → README.md, repos/
//   'repos/'                → repos/pppxxxy/
//   'repos/pppxxxy/'        → repos/pppxxxy/easychat2/
//
// 纪律：未实现的形状显式抛错。

export const calls = { createStore: 0, list: [] };

const TREE = {
  '': ['README.md', 'repos/'],
  'repos/': ['repos/pppxxxy/'],
  'repos/pppxxxy/': ['repos/pppxxxy/easychat2/'],
  'repos/pppxxxy/easychat2/': ['repos/pppxxxy/easychat2/package.json'],
};

function makeStore() {
  return {
    async listWorkspaceFiles({ subdir = '', depth = 1 } = {}) {
      calls.list.push({ subdir, depth });
      // 失控检测：挂载 effect 若误依赖 refresh，会「setCharacterId → refresh 换引用 →
      // effect 重跑 → 再 setCharacterId」地无限循环。不设阈值的话测试会**挂死**
      // （不是失败），CI 上表现为超时、本地要手动 kill。
      // 这里主动抛错，把「挂死」变成一条看得懂的失败。
      if (calls.list.length > 50) {
        throw new Error(
          `listWorkspaceFiles 被调用 ${calls.list.length} 次：挂载 effect 正在反复初始化`
          + '（依赖里很可能混进了 refresh；见 FilesPanel 挂载 effect 的注释）'
        );
      }
      // depth > 1 = 全量（搜索用）：把所有层摊平
      if (depth > 1) return Object.values(TREE).flat();
      return TREE[subdir] || [];
    },
    async fileUri() { return 'file:///doc/x'; },
    async readWorkspaceFile() { return { content: 'x' }; },
  };
}

export function createWorkspaceStore() {
  calls.createStore += 1;
  return makeStore();
}

export function describeWorkspaceRoot() {
  return { kind: 'app', label: '应用内', uri: 'file:///doc/' };
}

export function defaultWorkspaceRoot() {
  return 'file:///doc/workspace/';
}

// 下面这些被 FilesPanel 的**传递依赖**（工具注册、Git 面板、历史记录）按名导入。
// 渲染本测试不触达它们的功能，但模块加载阶段必须能解析到同名导出，
// 否则 ESM 会直接抛 "does not provide an export named ..."。
// 一律返回「关闭/不可用」的保守值，避免测试误以为这些能力真的启用了。
export function registerDefaultWorkspaceTools() {}
export function gitGateReason() { return 'not-configured'; }
export function shouldRecordFileHistory() { return false; }
export function resolveGitRunner() { return null; }
export function terminalGateReason() { return 'not-configured'; }
export function resolveTerminalSandboxRoot() { return ''; }

export default {
  createWorkspaceStore,
  describeWorkspaceRoot,
  defaultWorkspaceRoot,
  registerDefaultWorkspaceTools,
  gitGateReason,
  shouldRecordFileHistory,
  resolveGitRunner,
  terminalGateReason,
  resolveTerminalSandboxRoot,
};
