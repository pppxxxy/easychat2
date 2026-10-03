// 工作区默认接线：按设置选择「工作区后端」并登记工具。
//
// 惰性加载原生模块（测试环境 require 会抛错，故延迟到首次使用）：
// - expo-file-system/legacy —— 应用私有根（documentDirectory/workspace/）；
// - expo-file-system 新 API —— 用户自选的外部文件夹（content:// SAF）。
//
// 两种后端在 tools.js 眼里是同一个接口，所以「换根」不需要换工具定义。

import { normalizeWorkspaceLocation, resolveWorkspaceRoot, WORKSPACE_ROOT_KINDS } from './location.js';
import { getFileSystemNext } from './picker.js';
import { createExpoSafAdapter, createSafWorkspaceStore } from './safStore.js';
import { createLegacyWorkspaceStore } from './store.js';
import { registerWorkspaceTools } from './tools.js';

let fileSystemModule;
let fileSystemLoaded = false;

export function getWorkspaceFileSystem() {
  if (!fileSystemLoaded) {
    fileSystemLoaded = true;
    try {
      fileSystemModule = require('expo-file-system/legacy');
    } catch (error) {
      fileSystemModule = null;
    }
  }
  return fileSystemModule;
}

export function defaultWorkspaceRoot() {
  const fileSystem = getWorkspaceFileSystem();
  const base = (fileSystem && (fileSystem.documentDirectory || fileSystem.cacheDirectory)) || '';
  return `${base}workspace/`;
}

// 按设置构建后端。外部根但原生新 API 不可用时**抛错**而不是悄悄回落到应用私有根：
// 否则用户以为文件写进了自己选的文件夹，其实写进了应用沙盒——这类「静默改道」
// 比直接报错危险得多。
export function createWorkspaceStore(settings) {
  const location = normalizeWorkspaceLocation(settings && settings.location);
  if (location.kind !== WORKSPACE_ROOT_KINDS.SAF) {
    return createLegacyWorkspaceStore({
      root: defaultWorkspaceRoot(),
      fileSystem: getWorkspaceFileSystem(),
    });
  }
  return createSafWorkspaceStore({
    root: resolveWorkspaceRoot(location, defaultWorkspaceRoot()),
    adapter: createExpoSafAdapter(getFileSystemNext()),
  });
}

// 面板/工具共用的根描述：外部根返回文件夹名，应用私有根返回空串。
export function describeWorkspaceRoot(settings) {
  const location = normalizeWorkspaceLocation(settings && settings.location);
  if (location.kind !== WORKSPACE_ROOT_KINDS.SAF) {
    return { kind: WORKSPACE_ROOT_KINDS.APP, uri: defaultWorkspaceRoot(), name: '' };
  }
  return {
    kind: WORKSPACE_ROOT_KINDS.SAF,
    uri: resolveWorkspaceRoot(location, defaultWorkspaceRoot()),
    name: location.name,
  };
}

export function registerDefaultWorkspaceTools(settings) {
  return registerWorkspaceTools({ store: createWorkspaceStore(settings) });
}
