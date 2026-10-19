// `src/storage/workspace.js` 的桩（供 FilesPanel 渲染测试）。
//
// 真实模块会把整条存储栈拉进来。渲染测试只关心「面板初始化时解析了几次设置」，
// 所以这里给内存实现并记录调用次数。
//
// 纪律：只实现被测组件实际调用的四个函数；其余显式抛错，避免静默 undefined。

export const calls = { getSettings: 0, patch: 0 };

export async function getWorkspaceSettings() {
  calls.getSettings += 1;
  return {
    mode: 'write',
    location: { kind: 'app' },
    assistantCharacterId: '',
  };
}

export async function patchWorkspaceSettings() {
  calls.patch += 1;
}

export async function getWorkspaceChanges() {
  return [];
}

export async function clearWorkspaceChanges() {}

export default { getWorkspaceSettings, patchWorkspaceSettings, getWorkspaceChanges, clearWorkspaceChanges };
