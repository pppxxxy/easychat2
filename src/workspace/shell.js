// 工作区命令执行（run_shell）的 JS 桥与纯逻辑。
//
// 能力边界（必须如实说明，不要指望它像电脑上的终端）：
// - Android 上 RN 没有 exec 能力，本项目也没有，所以这里配了一个新的原生模块
//   （plugins/shellExecutor，ProcessBuilder("/system/bin/sh","-c",cmd)）；
// - 无 root 时 shell 只能访问应用自己的沙盒与 /system/bin 等公开路径，
//   **碰不到 SAF 的 content:// 路径**，也改不了别的应用的数据。
//   因此外部根下这个工具根本不注册（见 native.js 的门控）。
//
// 三层门控，任一层不过都执行不了：
// 1) 不注册 —— 开关关 / 外部根 / 原生模块缺失；
// 2) 不进工具列表 —— listToolsForMode 自然过滤；
// 3) 逐条确认 —— requiresConfirmation，由 UI 弹框，用户拒绝则绝不执行。
//
// 顶层不 import react-native（惰性 require），纯 Node 测试可直接加载纯函数。

import { sanitizeSandboxId } from './paths.js';
import {
  readShellSession,
  resolveCapturedCwd,
  SHELL_CWD_FILE,
  wrapShellCommand,
  writeShellSession,
} from './shellSession.js';
import { tActive } from '../i18n/index.js';

export const SHELL_OUTPUT_LIMIT = 64 * 1024;
export const SHELL_TIMEOUT_MS = 30000;
export const SHELL_TOOL_TIMEOUT_MS = 60000;

let rnState;
function getReactNative() {
  if (rnState !== undefined) return rnState;
  try {
    rnState = require('react-native');
  } catch (error) {
    rnState = null;
  }
  return rnState;
}

export function getShellNative() {
  const rn = getReactNative();
  if (!rn || !rn.Platform || rn.Platform.OS !== 'android') return null;
  const modules = rn.NativeModules || {};
  return modules.ShellExecutor || null;
}

export function isShellAvailable() {
  const native = getShellNative();
  return Boolean(native && typeof native.exec === 'function' && typeof native.kill === 'function');
}

// 工作区沙盒 uri（file:///…/workspace/<id>/）→ 真实文件系统路径。
// 原生 ProcessBuilder.directory 只认路径，不认 uri；顺便做百分号解码
// （角色 id 已被 sanitizeSandboxId 收成 [A-Za-z0-9_-]，但根路径仍可能含编码字符）。
export function sandboxPathFromUri(uri) {
  const value = String(uri || '');
  if (!value.startsWith('file://')) {
    throw new Error(tActive('error.workspace.shellPrivateOnly'));
  }
  const withoutScheme = value.slice('file://'.length);
  let decoded = withoutScheme;
  try {
    decoded = decodeURIComponent(withoutScheme);
  } catch (error) {
    decoded = withoutScheme;
  }
  // Windows 风格的 file:///C:/ 不在安卓目标内；这里只要求 path 是绝对路径。
  if (!decoded.startsWith('/')) {
    throw new Error(tActive('error.workspace.shellPathNotAbsolute'));
  }
  return decoded;
}

// 输出截断：命令可能刷出无穷输出（yes、大文件 cat）。截断要**标明**，别让模型
// 以为这就是全部内容而去改错文件。
// **头尾都保**（能力升级任务书 A2）：报错、失败原因几乎总在尾部——只保头等于把
// 诊断信息切掉，输出越长的命令越是如此。默认按 3:1 分配（头 48K / 尾 16K）。
export function truncateShellOutput(text, limit = SHELL_OUTPUT_LIMIT) {
  const value = String(text === undefined || text === null ? '' : text);
  if (value.length <= limit) return { text: value, truncated: false };
  const tailSize = Math.floor(limit / 4);
  const headSize = limit - tailSize;
  const omitted = value.length - limit;
  return {
    text: `${value.slice(0, headSize)}\n…（中间省略 ${omitted} 字符；需要看中段请用 grep/sed 收窄后重跑）…\n${value.slice(-tailSize)}`,
    truncated: true,
  };
}

// 把原生结果整理成给模型读的文本。exitCode 非 0 也算「执行成功但命令失败」，
// 以 isError 标记，让模型知道要看 stderr 而不是当成功继续。
export function formatShellResult(result) {
  const source = result && typeof result === 'object' ? result : {};
  const stdout = String(source.stdout || '');
  const stderr = String(source.stderr || '');
  const exitCode = Number.isFinite(source.exitCode) ? source.exitCode : 0;
  const lines = [`退出码：${exitCode}`];
  if (source.timedOut) lines.push(`命令超时（已终止）：超过 ${source.timeoutMs || SHELL_TIMEOUT_MS}ms`);
  if (stdout) lines.push(`标准输出：\n${stdout}`);
  if (stderr) lines.push(`标准错误：\n${stderr}`);
  if (!stdout && !stderr) lines.push('（无输出）');
  return { content: lines.join('\n'), isError: exitCode !== 0 || source.timedOut === true };
}

// 生成一次执行的请求 id：用于把「kill」精确投递到自己那条命令上。
export function createShellRequestId(seed = Date.now(), random = Math.random) {
  return `shell-${seed}-${Math.floor(random() * 1e9).toString(36)}`;
}

// 执行一条命令。signal 中止时立刻 kill 原生进程，并抛中止错误（由上层按取消处理）——
// 与工具循环的取消语义一致：用户点了停止，命令不能继续在后台跑。
export async function execShellCommand({
  command,
  cwdPath,
  signal = null,
  timeoutMs = SHELL_TIMEOUT_MS,
  native = getShellNative(),
  requestId = createShellRequestId(),
} = {}) {
  const text = String(command === undefined || command === null ? '' : command).trim();
  if (!text) throw new Error(tActive('error.workspace.shellCommandEmpty'));
  if (!native || typeof native.exec !== 'function') {
    throw new Error(tActive('error.workspace.shellUnsupported'));
  }
  // 已经中止就先返回，连原生都不进：既省一次进程启动，也避免「用户已点停止，
  // 结果还跑了一条命令」这种界面状态与实际不符的情况。
  if (signal && signal.aborted) throw makeAbortError();

  let onAbort = null;
  const abortPromise = new Promise((resolve, reject) => {
    if (!signal) return;
    if (signal.aborted) {
      reject(makeAbortError());
      return;
    }
    if (typeof signal.addEventListener === 'function') {
      onAbort = () => {
        // 先杀进程再拒绝：否则命令会被留在后台继续跑，与「已停止」的界面状态不符。
        try {
          if (typeof native.kill === 'function') native.kill(requestId);
        } catch (error) {}
        reject(makeAbortError());
      };
      signal.addEventListener('abort', onAbort);
    }
  });

  try {
    const result = await Promise.race([
      native.exec(text, cwdPath, timeoutMs, requestId),
      abortPromise,
    ]);
    return result || {};
  } finally {
    if (onAbort && signal && typeof signal.removeEventListener === 'function') {
      signal.removeEventListener('abort', onAbort);
    }
  }
}

function makeAbortError() {
  const error = new Error(tActive('error.agent.generationStopped'));
  error.name = 'AbortError';
  error.canceled = true;
  return error;
}

// 工具用的运行器：把「原生结果」翻译成工具返回文本，输出按上限截断。
//
// sandboxRoot 是应用私有工作区的真实路径（file:// 已转成绝对路径）；
// 每个角色在自己的子目录里跑，与文件工具同一沙盒——模型 ls 看到的就是它的工作区。
//
// store（可选，T7 持久会话）：给了就启用「目录记忆 + 环境变量注入」——
// 命令被 wrapShellCommand 包装：重放上次 cwd、跑完捕获结束目录写回 .easychat/env.json；
// env.json 里的环境变量注入每次执行。**没给 store 走原样执行**（与改动前一致）。
export function createShellRunner({ sandboxRoot, native, store } = {}) {
  return async ({ command, signal, characterId } = {}) => {
    const cwdPath = sandboxDirectoryPath(sandboxRoot, characterId);
    // 空命令交给 execShellCommand 抛统一错误（不包装，保住错误语义）。
    if (!store || !String(command == null ? '' : command).trim()) {
      const result = await execShellCommand({ command, cwdPath, signal, native });
      const out = truncateShellOutput(result.stdout);
      const err = truncateShellOutput(result.stderr);
      return formatShellResult({ ...result, stdout: out.text, stderr: err.text });
    }

    const session = await readShellSession(store, characterId);
    const wrapped = wrapShellCommand({ command, rootPath: cwdPath, cwd: session.cwd, env: session.env });
    const result = await execShellCommand({ command: wrapped, cwdPath, signal, native });

    // 捕获结束目录 → 变了才回写（没变省一次写；读写失败绝不影响命令结果本身）。
    let currentCwd = session.cwd;
    try {
      const captured = await store.readWorkspaceFile({ characterId, path: SHELL_CWD_FILE });
      const cwd = resolveCapturedCwd(captured && captured.content, cwdPath);
      if (cwd !== null) {
        currentCwd = cwd;
        if (cwd !== session.cwd) {
          await writeShellSession(store, characterId, { cwd, env: session.env });
        }
      }
    } catch (error) {}

    const out = truncateShellOutput(result.stdout);
    const err = truncateShellOutput(result.stderr);
    const formatted = formatShellResult({ ...result, stdout: out.text, stderr: err.text });
    // 附一行当前目录：目录现在会被记住（不再每条回到根），模型必须知道自己在哪。
    return {
      ...formatted,
      content: `当前目录：${currentCwd || '（工作区根）'}\n${formatted.content}`,
    };
  };
}

// 沙盒目录的真实路径：根 + sanitize 过的角色 id（与 paths.sandboxDirectory 同一规则）。
export function sandboxDirectoryPath(sandboxRoot, characterId) {
  const base = String(sandboxRoot || '').replace(/\/+$/, '');
  if (!base) throw new Error(tActive('error.workspace.shellRootMissing'));
  return `${base}/${sanitizeSandboxId(characterId)}`;
}
