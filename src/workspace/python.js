// Python 环境（Chaquopy 内置 CPython）的 JS 桥与纯逻辑。
//
// 口径（核实报告 §2.4 修正）：**没有运行时 pip**——包必须在构建时由 build.gradle 的
// pip 块装进 APK（见 plugins/withChaquopy.js 的 BUNDLED_PACKAGES）。所以界面只如实展示
// 「已打进包的依赖」，不提供装包、也不切镜像源（那是做不到的事）。
//
// 安全边界（如实标注）：Chaquopy 没有中断机制——跑飞的脚本杀不掉（shell 有
// destroyForcibly，Python 没有）。因此 agent 侧**不注册 run_python 工具**，只允许
// 用户亲手运行，避免模型把应用卡在一个停不下来的脚本上。
//
// 顶层不 import react-native（惰性 require），纯 Node 测试可直接加载纯函数。

import { sanitizeSandboxId } from './paths.js';
import { tActive } from '../i18n/index.js';

export const PYTHON_OUTPUT_LIMIT = 64 * 1024;

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

export function isPythonAvailable() {
  const native = getPythonNative();
  return Boolean(native && typeof native.runScript === 'function');
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

// 执行一段代码。cwdPath 是应用私有工作区里该角色的沙盒真实路径。
export async function runPythonScript({ code, cwdPath, native = getPythonNative() } = {}) {
  const source = String(code === undefined || code === null ? '' : code);
  if (!source.trim()) throw new Error(tActive('error.workspace.pythonCodeEmpty'));
  if (!native || typeof native.runScript !== 'function') {
    throw new Error(tActive('error.workspace.pythonUnsupported'));
  }
  const result = await native.runScript(source, String(cwdPath || ''));
  return formatPythonResult(result);
}

// 与文件工具同一沙盒的绝对路径（根 + 角色子目录）。
export function pythonCwdPath(sandboxRoot, characterId) {
  const base = String(sandboxRoot || '').replace(/\/+$/, '');
  if (!base) throw new Error(tActive('error.workspace.shellRootMissing'));
  return `${base}/${sanitizeSandboxId(characterId)}`;
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
