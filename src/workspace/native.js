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
import { createShellRunner, getShellNative, isShellAvailable, sandboxPathFromUri } from './shell.js';
import { createHistoryRecordingStore } from './history.js';
import { createLegacyWorkspaceStore } from './store.js';
import { registerWorkspaceTools } from './tools.js';
import { normalizeWorkspaceMode } from './settings.js';
import { AGENT_MODES } from '../agent/tools/registry.js';

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
  const base = location.kind !== WORKSPACE_ROOT_KINDS.SAF
    ? createLegacyWorkspaceStore({
      root: defaultWorkspaceRoot(),
      fileSystem: getWorkspaceFileSystem(),
    })
    : createSafWorkspaceStore({
      root: resolveWorkspaceRoot(location, defaultWorkspaceRoot()),
      adapter: createExpoSafAdapter(getFileSystemNext()),
    });
  // 改动历史记录装饰器：面板与聊天工具共用这条后端路径，记录点唯一。
  // 记录失败被装饰器吞掉，绝不影响文件操作本身。
  return createHistoryRecordingStore(base);
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
  return registerWorkspaceTools({
    store: createWorkspaceStore(settings),
    shell: resolveShellRunner(settings),
  });
}

// 命令执行门控（纯判定，可单测）。返回 '' 表示「可以注册」，否则是不注册的原因。
// 三层里任何一层不过，run_shell 都不会进注册表：
// 1) 设置开关（且只在「可改」模式下成立）；
// 2) 根必须是应用私有目录——无 root 的 sh 访问不了 SAF 的 content://；
// 3) 原生模块真的可用（否则注册了也只是每次报「不支持」）。
//
// 抽成纯函数是因为它**只是判定**：真实环境里「原生模块不可用」会把其它原因掩盖掉，
// 于是把 SAF 那条判断写坏也测不出来（注入验证实测如此）。分开之后每条都钉得住。
export function shellGateReason(settings, { shellAvailable = false } = {}) {
  const source = settings && typeof settings === 'object' ? settings : {};
  if (source.allowCommandExecution !== true) return 'SWITCH_OFF';
  if (normalizeWorkspaceMode(source.mode) !== AGENT_MODES.WRITE) return 'NOT_WRITE_MODE';
  if (normalizeWorkspaceLocation(source.location).kind === WORKSPACE_ROOT_KINDS.SAF) return 'EXTERNAL_ROOT';
  if (!shellAvailable) return 'SHELL_NOT_AVAILABLE';
  return '';
}

// 返回 null 表示「不注册」，而不是「注册了再报错」。
export function resolveShellRunner(settings) {
  if (shellGateReason(settings, { shellAvailable: isShellAvailable() }) !== '') return null;
  const native = getShellNative();
  let sandboxRoot;
  try {
    // 工作目录是应用私有工作区根；具体执行时 runner 会再拼上角色子目录，
    // 与文件工具同一沙盒——模型 ls 看到的就是它自己的工作区。
    sandboxRoot = sandboxPathFromUri(defaultWorkspaceRoot()).replace(/\/+$/, '');
  } catch (error) {
    return null;
  }
  return createShellRunner({ native, sandboxRoot });
}
