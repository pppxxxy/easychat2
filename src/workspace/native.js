// 工作区默认接线：惰性加载 expo-file-system/legacy（原生模块在测试环境 require
// 会抛错，故延迟到首次使用），并向注册表登记默认工具的便捷入口。

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

export function registerDefaultWorkspaceTools() {
  return registerWorkspaceTools({
    root: defaultWorkspaceRoot(),
    fileSystem: getWorkspaceFileSystem(),
  });
}