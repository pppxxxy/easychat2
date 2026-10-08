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

// 「原生模块注册了没」——只说明这个 APK 带了桥，**不代表 Python 真能跑**。
// 界面不要用这个判断可用性（曾因此把「已打包」显示成「运行时可用」）。
export function isPythonBridgePresent({ native = getPythonNative() } = {}) {
  return Boolean(native && typeof native.runScript === 'function');
}

// 「Python 真的能用」——问原生（它会实际尝试启动解释器）。
// 为什么必须问原生：Chaquopy 的 Python.getInstance() 在未启动时会自动用
// GenericPlatform，而 GenericPlatform 在 Android 上必然抛异常，所以「模块已注册」
// 与「解释器能启动」是两件事。异步是因为启动要把标准库解压到应用目录，首次较慢。
export async function isPythonAvailable({ native = getPythonNative() } = {}) {
  if (!native || typeof native.runScript !== 'function') return false;
  if (typeof native.isAvailable !== 'function') return false;
  try {
    return (await native.isAvailable()) === true;
  } catch (error) {
    return false;
  }
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
