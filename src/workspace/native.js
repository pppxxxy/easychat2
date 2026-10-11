// 工作区默认接线：按设置选择「工作区后端」并登记工具。
//
// 惰性加载原生模块（测试环境 require 会抛错，故延迟到首次使用）：
// - expo-file-system/legacy —— 应用私有根（documentDirectory/workspace/）；
// - expo-file-system 新 API —— 用户自选的外部文件夹（content:// SAF）。
//
// 两种后端在 tools.js 眼里是同一个接口，所以「换根」不需要换工具定义。

import { ciBridge } from './ci.js';
import { normalizeWorkspaceLocation, resolveWorkspaceRoot, WORKSPACE_ROOT_KINDS } from './location.js';
import { getFileSystemNext } from './picker.js';
import { createExpoSafAdapter, createSafWorkspaceStore } from './safStore.js';
import { createShellRunner, getShellNative, isShellAvailable, sandboxPathFromUri } from './shell.js';
import { createPythonRunner, getPythonNative, isPythonBridgePresent } from './python.js';
import { createHistoryRecordingStore } from './history.js';
import { createLegacyWorkspaceStore } from './store.js';
import { registerWorkspaceTools } from './tools.js';
import { createWorkspaceGit } from './git.js';
import { normalizeWorkspaceMode } from './settings.js';
import { normalizeRetention } from './retention.js';
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
  const store = createHistoryRecordingStore(base);
  // P1-11：保留口径随 store 带下去（fileHistory / rollbackBaseline / sessionEvents 三处
  // 旁路各自读 `store.retention`，缺失即默认）。放在这里是因为这三个模块的调用点分散
  // （写系工具、推送面板、聊天面板），store 是它们唯一的公共输入。
  return { ...store, retention: normalizeRetention(settings && settings.retention) };
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

// extras.readLog（A5）：宿主（工作区面板）注入的会话级已读登记；不传 = read 不登记。
// extras.materializer（C2）：宿主注入的按需物化函数（读不到清单内文件时试一次）；
// 不传 = 不物化（与旧版行为一致）。
// ci（H1）：默认注入云构建桥（ci.js 的 token 读取是惰性的，模块加载零副作用）；
// extras.ci 可覆盖（测试注入假桥）。
export function registerDefaultWorkspaceTools(settings, extras = {}) {
  return registerWorkspaceTools({
    store: createWorkspaceStore(settings),
    shell: resolveShellRunner(settings),
    python: resolvePythonRunner(settings),
    git: resolveGitRunner(settings),
    // W7：git 开着就不再写快照（见 shouldRecordFileHistory 的注释）。
    recordFileHistory: shouldRecordFileHistory(settings),
    readLog: extras.readLog || null,
    materializer: typeof extras.materializer === 'function' ? extras.materializer : null,
    ci: extras.ci || ciBridge,
    // O0.3 计划落盘：宿主注入（不传 = update_plan 不落盘）。
    onPlan: typeof extras.onPlan === 'function' ? extras.onPlan : null,
  });
}

// 本地 git 门控（纯判定，可单测）。返回 '' 表示「可以注册」，否则是不注册的原因。
// 与 shell / python 的差别：isomorphic-git 是**纯 JS**（随包打进 bundle），没有「原生模块
// 不可用」这一层，所以只有两道门：
// 1) 设置开关（默认关——git 会在工作区里建 .git/ 并写入提交历史，属用户显式选择）；
// 2) 根必须是应用私有目录——SAF 的 content:// 撑不起 .git 的原子重命名与锁语义。
// 不要求工作模式：三个只读工具在任何模式下都无害（read 模式下正好用来回看自己改过什么）。
export function gitGateReason(settings) {
  const source = settings && typeof settings === 'object' ? settings : {};
  if (source.allowLocalGit !== true) return 'SWITCH_OFF';
  if (normalizeWorkspaceLocation(source.location).kind === WORKSPACE_ROOT_KINDS.SAF) return 'EXTERNAL_ROOT';
  return '';
}

// W7 退旧第一步：本地 git 开着（且根是应用内）时**不再记写前快照**——同一件事现在由回合
// 检查点（每轮提交）与 git_discard（回滚）覆盖，两份历史并存只会让「哪份才算数」变模糊。
// 注意 SAF 根下 git 不可用（gitGateReason 会给 EXTERNAL_ROOT），那里**必须继续记快照**，
// 否则外部文件夹就彻底没有回退手段了。
export function shouldRecordFileHistory(settings) {
  return gitGateReason(settings) !== '';
}

// git runner：**按调用开仓库句柄**——沙盒路径是 root/<characterId>/，而角色要到工具执行时
// （ctx.characterId）才知道，所以不能在注册期定死一个句柄。门控不过返回 null → 三个 git 工具
// 都不进注册表（第一层门控）。
// ensureRepo 给「用户在设置里打开开关」时用：建仓库但不提交（首次提交留给回合检查点）。
export function resolveGitRunner(settings) {
  if (gitGateReason(settings) !== '') return null;
  const root = defaultWorkspaceRoot();
  const fileSystem = getWorkspaceFileSystem();
  const open = ({ characterId = 'default' } = {}) => createWorkspaceGit({ root, characterId, fileSystem });
  return {
    open,
    ensureRepo: async ({ characterId = 'default' } = {}) => {
      const handle = open({ characterId });
      if (!(await handle.isRepo())) await handle.init();
      return handle;
    },
  };
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

// 终端面板的门控（纯判定，可单测）。与 agent 的 run_shell 共用「允许执行命令」开关——
// 不新开一条安全面：开关关着时终端也进不去。区别只在**不要求工作模式**（命令由用户亲手
// 输入、不经过模型），以及不需要逐条确认（见 v4 §4）。外部根同样不可用：无 root 的 sh
// 碰不到 SAF 的 content://。
export function terminalGateReason(settings, { shellAvailable = false } = {}) {
  const source = settings && typeof settings === 'object' ? settings : {};
  if (source.allowCommandExecution !== true) return 'SWITCH_OFF';
  if (normalizeWorkspaceLocation(source.location).kind === WORKSPACE_ROOT_KINDS.SAF) return 'EXTERNAL_ROOT';
  if (!shellAvailable) return 'SHELL_NOT_AVAILABLE';
  return '';
}

// 终端的工作目录根：应用私有工作区的**真实路径**（file:// 转绝对路径）。
// 门控不过或路径拿不到时返回 null（面板据此显示原因，而不是执行了再报错）。
export function resolveTerminalSandboxRoot(settings, { shellAvailable = false } = {}) {
  if (terminalGateReason(settings, { shellAvailable }) !== '') return null;
  try {
    return sandboxPathFromUri(defaultWorkspaceRoot()).replace(/\/+$/, '');
  } catch (error) {
    return null;
  }
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
  // store：持久会话（T7）读写 .easychat/env.json；建失败不影响命令执行本身
  //（runner 对无 store 走原样执行，行为与改动前一致）。
  let store = null;
  try {
    store = createWorkspaceStore(settings);
  } catch (error) {
    store = null;
  }
  return createShellRunner({ native, sandboxRoot, store });
}

// Python 执行的门控（纯判定，可单测）。与 shell 同形，但看的是另一个开关。
//
// 注意这里用的是**同步**的 isPythonBridgePresent()（「这个 APK 带了桥」），而不是
// probePython() 那个异步的真实探测——注册发生在启动路径上，没法 await。代价是
// 「桥在但解释器起不来」时工具仍会注册，每次调用返回一条诚实的错误；界面侧仍用
// 异步探测显示真实状态（两边分工写清楚，别把同步判断当可用性）。
export function pythonAgentGateReason(settings, { pythonAvailable = false } = {}) {
  const source = settings && typeof settings === 'object' ? settings : {};
  if (source.allowPythonExecution !== true) return 'SWITCH_OFF';
  if (normalizeWorkspaceMode(source.mode) !== AGENT_MODES.WRITE) return 'NOT_WRITE_MODE';
  if (normalizeWorkspaceLocation(source.location).kind === WORKSPACE_ROOT_KINDS.SAF) return 'EXTERNAL_ROOT';
  if (!pythonAvailable) return 'PYTHON_NOT_AVAILABLE';
  return '';
}

export function resolvePythonRunner(settings) {
  if (pythonAgentGateReason(settings, { pythonAvailable: isPythonBridgePresent() }) !== '') return null;
  const native = getPythonNative();
  let sandboxRoot;
  try {
    sandboxRoot = sandboxPathFromUri(defaultWorkspaceRoot()).replace(/\/+$/, '');
  } catch (error) {
    return null;
  }
  // store：读 .easychat/env.json（T7 会话），把环境变量注入 run_python——与 run_shell
  // 读同一份文件，两种执行器对「工作区会话」的读法保持一致。建失败不影响执行本身
  //（runner 对无 store 走原样，脚本逐字节不变）。
  let store = null;
  try {
    store = createWorkspaceStore(settings);
  } catch (error) {
    store = null;
  }
  return createPythonRunner({ native, sandboxRoot, store });
}
