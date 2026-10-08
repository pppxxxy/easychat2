// Python 环境（Chaquopy 内置 CPython）的 JS 桥与纯逻辑。
//
// 口径（核实报告 §2.4 修正）：**没有运行时 pip**——包必须在构建时用 build.gradle 的
// pip 块装进 APK（见 plugins/withChaquopy.js 的 BUNDLED_PACKAGES）。所以界面只如实展示
// 「已打进包的依赖」，不提供装包、也不切镜像源（那是做不到的事）。
//
// 安全边界（2026-10-08 更新，别再按旧说法写）：Chaquopy **自身没有中断机制**——解释器
// 层面杀不掉跑飞的脚本。所以脚本跑在 `:python` 独立进程里（plugins/chaquopy/android/
// PythonService.kt），「停止」= 杀掉那个进程，主进程（UI）不受影响，下一次运行会自动
// 重启解释器。**这正是「模型可以运行 Python」的前提**：停得掉，才敢把执行权交给模型。
//
// 顶层不 import react-native（惰性 require），纯 Node 测试可直接加载纯函数。

import { sanitizeSandboxId } from './paths.js';
import { tActive } from '../i18n/index.js';

export const PYTHON_OUTPUT_LIMIT = 64 * 1024;

// 原生侧看门狗：超过就杀掉 :python 进程（脚本杀不掉，进程杀得掉）。
// 工具超时必须**大于**看门狗——让原生先动手，模型收到的是「超时被强制终止」这条真话，
// 而不是工具层自己编一个「超时」把真相盖掉（与 shell 的 30s/60s 同一口径）。
export const PYTHON_WATCHDOG_MS = 30000;
export const PYTHON_TOOL_TIMEOUT_MS = 60000;

// 与 plugins/withChaquopy.js 的 BUNDLED_PACKAGES 保持一致（构建期依赖清单）。
//
// **两处必须同步**，这是刻意保留的重复：插件是预构建期脚本（Node CJS，跑在
// Gradle 之前），JS 层是应用运行期模块（跑在设备上），运行时无法互相 import。
// 不一致的后果是「界面显示的依赖 ≠ 真正打进包的依赖」——用户在界面上看到
// requests 2.31 就以为装的是它。所以这里加了测试逐条比对两边清单。
// 版本依据见 withChaquopy.js 的注释（requests 升到 2.34.2 修两个 CVE）。
export const PYTHON_BUNDLED_PACKAGES = Object.freeze([
  'requests==2.34.2',
  'charset-normalizer==3.5.2',
  'idna==3.20',
  'urllib3==2.8.0',
  'certifi==2026.7.22',
]);

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

export function getPythonNative() {
  const rn = getReactNative();
  if (!rn || !rn.Platform || rn.Platform.OS !== 'android') return null;
  const modules = rn.NativeModules || {};
  return modules.PythonBridge || null;
}

// 「原生模块注册了没」——只说明这个 APK 带了桥，**不代表 Python 真能跑**。
// 界面不要用这个判断可用性（曾因此把「已打包」显示成「运行时可用」）。
// 用于**同步**场景（工具注册时无法 await），异步的真实判断见 probePython。
export function isPythonBridgePresent({ native = getPythonNative() } = {}) {
  return Boolean(native && typeof native.runScript === 'function');
}

// ---- 原生返回值的解析 ----
//
// 桥的返回契约是**一整条 JSON 字符串**（Python 侧 json.dumps）。为什么不让 dict 跨语言
// 边界：Kotlin 拿到的 PyObject.get 是 getattr() 语义，对 dict 取 "stdout" 得到 null 且
// 不报错——真机表现是「退出码 0、没有任何输出」。详见 easychat2_bridge.py。
// 解析放在 JS 侧：这里能单测，也能把「原样返回了什么」写进错误消息里。
export function parsePythonPayload(payload) {
  const text = String(payload === undefined || payload === null ? '' : payload);
  if (!text.trim()) throw new Error(tActive('error.workspace.pythonEmptyPayload'));
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    parsed = null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(tActive('error.workspace.pythonBadPayload', { text: text.slice(0, 200) }));
  }
  return parsed;
}

// 「Python 真的能用」——问原生（它会实际尝试启动解释器，并把**服务进程的 pid**带回来）。
// 为什么必须问原生：Chaquopy 的 Python.getInstance() 在未启动时会自动用 GenericPlatform，
// 而 GenericPlatform 在 Android 上必然抛异常，所以「模块已注册」与「解释器能启动」是两件事。
// 为什么 pid 也要看：脚本跑在独立进程里是「能停掉」的前提，pid 相同说明 android:process
// 没生效——那时宁可报不可用，也不能给一个杀不掉的执行入口（失败朝安全方向倒）。
export async function probePython({ native = getPythonNative() } = {}) {
  if (!native || typeof native.probe !== 'function') {
    return { available: false, reason: 'NO_BRIDGE', pid: 0, error: '' };
  }
  let payload;
  try {
    payload = parsePythonPayload(await native.probe());
  } catch (error) {
    return { available: false, reason: 'PROBE_FAILED', pid: 0, error: (error && error.message) || '' };
  }
  if (payload.sameProcess === true) {
    return { available: false, reason: 'NOT_ISOLATED', pid: 0, error: String(payload.error || '') };
  }
  if (payload.ok !== true) {
    return { available: false, reason: 'START_FAILED', pid: 0, error: String(payload.error || '') };
  }
  return { available: true, reason: '', pid: Number(payload.pid) || 0, error: '' };
}

export async function isPythonAvailable(options) {
  const probe = await probePython(options);
  return probe.available === true;
}

// ---- 实装探测：声明 ≠ 实装 ----
//
// PYTHON_BUNDLED_PACKAGES 只是**构建时声明的清单**。最小原型构建（minimalPackages）
// 会跳过 pip 块，此时清单里那些包根本不在 APK 里；界面若照清单显示「已打进 APK」，
// 就成了假话（用户真机截图里就是这个情况）。所以这里向解释器本身查实装。
//
// 纯逻辑（脚本生成 + 输出解析）可 Node 直测；执行走同一个 runScript 通道。

const PACKAGE_PROBE_MARK = '__ech2_pkg__';

// 发行名去掉版本约束：importlib.metadata 按发行名查，不吃 "==版本"。
export function packageNamesOf(packages) {
  return (Array.isArray(packages) ? packages : [])
    .map(item => String(item || '').split('==')[0].trim())
    .filter(Boolean);
}

// 生成探测脚本：逐个查发行名，输出带固定标记的行，便于稳健解析。
export function buildPackageProbeScript(packages) {
  const names = packageNamesOf(packages);
  if (names.length === 0) return '';
  const literal = names.map(name => `'${name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`).join(', ');
  return [
    'import importlib.metadata as _ech2_md',
    `for _ech2_name in [${literal}]:`,
    '    try:',
    `        _ech2_ver = _ech2_md.version(_ech2_name)`,
    '    except Exception:',
    `        _ech2_ver = ''`,
    `    print('${PACKAGE_PROBE_MARK}' + '\\t' + _ech2_name + '\\t' + _ech2_ver)`,
  ].join('\n');
}

// 解析探测输出 → { installed: [{name, version}], missing: [name] }
// 认不出的行直接忽略（stdout 可能混入 import 期间的杂项输出）。
export function parsePackageProbe(stdout, packages) {
  const names = packageNamesOf(packages);
  const found = new Map();
  String(stdout || '').split('\n').forEach(line => {
    const trimmed = line.trim();
    if (!trimmed.startsWith(PACKAGE_PROBE_MARK)) return;
    const [, name, version] = trimmed.split('\t');
    if (!name) return;
    found.set(String(name).trim(), String(version || '').trim());
  });
  const installed = [];
  const missing = [];
  names.forEach(name => {
    if (found.has(name) && found.get(name)) {
      installed.push({ name, version: found.get(name) });
    } else {
      missing.push(name);
    }
  });
  return { installed, missing };
}

// 向解释器查实装清单。原生不可用 / 探测失败时返回 null，
// 让界面退回「构建时声明」的说法，而不是假装知道实装。
export async function probeInstalledPackages({
  cwdPath,
  packages = PYTHON_BUNDLED_PACKAGES,
  native = getPythonNative(),
} = {}) {
  const script = buildPackageProbeScript(packages);
  if (!script || !cwdPath) return null;
  try {
    const result = await runPythonScript({ code: script, cwdPath, native });
    if (!result || result.isError) return null;
    return parsePackageProbe(result.stdout, packages);
  } catch (error) {
    return null;
  }
}

// 输出截断：与 shell 同一口径，标明截断而不是假装这就是全部。
export function truncatePythonOutput(text, limit = PYTHON_OUTPUT_LIMIT) {
  const value = String(text === undefined || text === null ? '' : text);
  if (value.length <= limit) return { text: value, truncated: false };
  return { text: `${value.slice(0, limit)}\n…（输出已截断，仅保留前 ${limit} 字符）`, truncated: true };
}

// 原生结果 → 面板可渲染的结构（exitCode 非 0 算「跑完了但报错」，不是崩溃）。
export function formatPythonResult(result) {
  const source = result && typeof result === 'object' ? result : {};
  const stdout = truncatePythonOutput(source.stdout);
  const stderr = truncatePythonOutput(source.stderr);
  const exitCode = Number.isFinite(source.exitCode) ? source.exitCode : 0;
  return {
    stdout: stdout.text,
    stderr: stderr.text,
    exitCode,
    truncated: stdout.truncated || stderr.truncated,
    isError: exitCode !== 0,
  };
}

// 工具返回给模型的文本。措辞与 formatShellResult 保持一致——两种执行器一个读法，
// 模型不用为「shell 的输出长什么样、python 的输出长什么样」分别适应。
//
// isError 由 **exitCode 现算**，不读调用方给的 isError 标记：传进来的可能是
// formatPythonResult 的结果，也可能是原生形状的对象（没有 isError 字段）。
// 只看标记的话，后者会把「退出码 2」报成成功——正是本文件反复出现的那类静默错误。
export function formatPythonToolResult(result) {
  const source = result && typeof result === 'object' ? result : {};
  const exitCode = Number.isFinite(source.exitCode) ? source.exitCode : 0;
  const lines = [`退出码：${exitCode}`];
  if (source.stdout) lines.push(`标准输出：\n${source.stdout}`);
  if (source.stderr) lines.push(`标准错误：\n${source.stderr}`);
  if (!source.stdout && !source.stderr) lines.push('（无输出）');
  return { content: lines.join('\n'), isError: exitCode !== 0 };
}

// 与 shell.js / registry.js 同形状（三处重复是现状，语义必须一致：name=AbortError 与
// canceled=true，工具循环靠这两个标记识别「用户点了停止」而不是执行失败）。
function makeAbortError() {
  const error = new Error(tActive('error.agent.generationStopped'));
  error.name = 'AbortError';
  error.canceled = true;
  return error;
}

// 请求原生停止当前脚本：杀死 :python 进程。返回「请求是否送达」，不表示「已停止」——
// 真正的结果由那次运行的 promise 以 reject 的形式给出（进程被杀时绑定断开）。
export async function cancelPythonScript({ native = getPythonNative() } = {}) {
  if (!native || typeof native.cancel !== 'function') return false;
  try {
    await native.cancel();
    return true;
  } catch (error) {
    return false;
  }
}

// 执行一段代码。cwdPath 是应用私有工作区里该角色的沙盒真实路径。
// - timeoutMs：原生看门狗，>0 时超时会杀掉 :python 进程（手动运行传 0 = 不设，由用户点停止）；
// - signal：中止时立刻请求杀进程，并抛中止错误（与工具循环的取消语义一致：
//   用户点了停止，就不该还有脚本在后台跑）。
export async function runPythonScript({
  code,
  cwdPath,
  timeoutMs = 0,
  signal = null,
  native = getPythonNative(),
} = {}) {
  const source = String(code === undefined || code === null ? '' : code);
  if (!source.trim()) throw new Error(tActive('error.workspace.pythonCodeEmpty'));
  if (!native || typeof native.runScript !== 'function') {
    throw new Error(tActive('error.workspace.pythonUnsupported'));
  }
  if (signal && signal.aborted) throw makeAbortError();

  const timeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : 0;
  let onAbort = null;
  const abortPromise = new Promise((resolve, reject) => {
    if (!signal || typeof signal.addEventListener !== 'function') return;
    onAbort = () => {
      // 先请求杀进程再拒绝：否则脚本会留在后台继续跑，与「已停止」的界面状态不符。
      cancelPythonScript({ native });
      reject(makeAbortError());
    };
    signal.addEventListener('abort', onAbort);
  });

  try {
    const payload = await Promise.race([
      native.runScript(source, String(cwdPath || ''), timeout),
      abortPromise,
    ]);
    return formatPythonResult(parsePythonPayload(payload));
  } finally {
    if (onAbort && signal && typeof signal.removeEventListener === 'function') {
      signal.removeEventListener('abort', onAbort);
    }
  }
}

// 与文件工具同一沙盒的绝对路径（根 + 角色子目录）。
export function pythonCwdPath(sandboxRoot, characterId) {
  const base = String(sandboxRoot || '').replace(/\/+$/, '');
  if (!base) throw new Error(tActive('error.workspace.shellRootMissing'));
  return `${base}/${sanitizeSandboxId(characterId)}`;
}

// 工具用的运行器：把脚本结果翻译成给模型读的文本，输出按上限截断。
// 看门狗固定为 PYTHON_WATCHDOG_MS——模型调用必须自我了断，不能等用户来点停止。
export function createPythonRunner({ sandboxRoot, native } = {}) {
  return async ({ code, signal, characterId } = {}) => {
    const cwdPath = pythonCwdPath(sandboxRoot, characterId);
    const result = await runPythonScript({
      code,
      cwdPath,
      timeoutMs: PYTHON_WATCHDOG_MS,
      signal,
      native,
    });
    return formatPythonToolResult(result);
  };
}

// 门控：Chaquopy 的工作目录必须是真实文件系统路径，所以外部根（SAF content://）下不可用；
// 原生模块没打进包时也不可用。
export function pythonGateReason(settings, { pythonAvailable = false } = {}) {
  const source = settings && typeof settings === 'object' ? settings : {};
  const location = source.location && typeof source.location === 'object' ? source.location : {};
  if (String(location.kind || 'app') === 'saf') return 'EXTERNAL_ROOT';
  if (!pythonAvailable) return 'NOT_BUNDLED';
  return '';
}
