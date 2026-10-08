// Python 环境（Chaquopy，T2）：JS 纯逻辑 + 预构建插件的纯变换 + 桥的契约。
//
// 已启用（2026-10-08）：app.json 挂了 withChaquopy，第一步是最小原型。Gradle 级集成
// 只能靠真机 APK 构建验证——所以这里除了纯逻辑，还加了「真跑本机 CPython 执行桥模块」
// 的一组测试：桥的 Python 侧是纯 Python，本机能跑的就别只做文本断言。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

import {
  formatPythonResult,
  isPythonAvailable,
  isPythonBridgePresent,
  buildPackageProbeScript,
  packageNamesOf,
  parsePackageProbe,
  probeInstalledPackages,
  PYTHON_BUNDLED_PACKAGES,
  PYTHON_OUTPUT_LIMIT,
  pythonCwdPath,
  pythonGateReason,
  runPythonScript,
  truncatePythonOutput,
} from '../src/workspace/python.js';

const require = createRequire(import.meta.url);
const plugin = require('../plugins/withChaquopy.js');
const T = plugin.__testables;

// 两处清单必须逐条一致：插件是预构建期 CJS（跑在 Gradle 之前），JS 层是运行期
// 模块（跑在设备上），运行时无法互相 import，所以只能在测试里比对。
// 不一致的后果是「界面显示的依赖 ≠ 真正打进包的依赖」——用户看着界面以为装的是这个版本。
test('依赖清单同步：JS 层展示的清单与插件真正装进包的清单完全一致', () => {
  assert.deepEqual(
    [...PYTHON_BUNDLED_PACKAGES].sort(),
    [...T.BUNDLED_PACKAGES].sort(),
    'src/workspace/python.js 与 plugins/withChaquopy.js 的依赖清单已漂移'
  );
});

// 版本选择有安全依据，不能随手改回去。这里把「为什么是这个版本」钉在测试里：
// 若有人把 requests 降级到含 CVE 的版本，这条会红并说明原因。
test('依赖安全：requests 不含已知 CVE（CVE-2024-47081 修于 2.32.4；CVE-2026-25645 修于 2.33.0）', () => {
  const entry = PYTHON_BUNDLED_PACKAGES.find(name => /^requests==/.test(name));
  assert.ok(entry, '清单里应有 requests');
  const version = entry.split('==')[1];
  const parts = version.split('.').map(Number);
  const atLeast = (major, minor, patch) => {
    if (parts[0] !== major) return parts[0] > major;
    if (parts[1] !== minor) return parts[1] > minor;
    return (parts[2] || 0) >= patch;
  };
  assert.ok(atLeast(2, 33, 0),
    `requests ${version} 仍含已修复的 CVE：CVE-2024-47081 需 >=2.32.4，CVE-2026-25645 需 >=2.33.0`);
});

test('app 内 Python 版本：显式钉住，且在 Chaquopy 16.1 支持范围内', () => {
  // 16.1 支持 3.9–3.13（默认 3.8）；requests 2.34.x 要求 >=3.10。
  assert.ok(['3.9', '3.10', '3.11', '3.12', '3.13'].includes(T.PYTHON_VERSION),
    `PYTHON_VERSION=${T.PYTHON_VERSION} 不在 Chaquopy 16.1 支持范围（3.9–3.13）`);
  const [maj, min] = T.PYTHON_VERSION.split('.').map(Number);
  assert.ok(maj === 3 && min >= 10, 'requests 2.34.x 的 requires_python 是 >=3.10');
});

// 最小原型：只验 Chaquopy 能否打进包并初始化，不装任何第三方包。
// 空清单时必须整块省略 pip（而不是留一个空的 pip { }，那既无意义也可能不被 Gradle 接受）。
test('最小原型模式：空清单不产出 pip 块，且 Gradle 结构仍然平衡', () => {
  const gradle = [
    'apply plugin: "com.android.application"',
    'android {',
    '    defaultConfig {',
    '        applicationId "com.pppxxxy.easychat2"',
    '    }',
    '}',
  ].join('\n');
  const empty = T.applyChaquopyConfig(gradle, { packages: [] });
  assert.equal(/pip\s*\{/.test(empty), false, '空清单不应产出 pip 块');
  assert.ok(empty.includes('python {'), 'python 块本身仍要在');
  assert.ok(empty.includes(`version "${T.PYTHON_VERSION}"`), '版本仍要钉住');
  assert.equal((empty.match(/\{/g) || []).length, (empty.match(/\}/g) || []).length, '大括号平衡');

  // 非空时 pip 块必须在，且每条都带 install
  const full = T.applyChaquopyConfig(gradle);
  assert.ok(/pip\s*\{/.test(full), '非空清单要有 pip 块');
  assert.equal((full.match(/install "/g) || []).length, T.BUNDLED_PACKAGES.length);
  assert.equal((full.match(/\{/g) || []).length, (full.match(/\}/g) || []).length, '大括号平衡');
});

test('truncatePythonOutput / formatPythonResult：截断标明、错误码即失败', () => {
  const small = truncatePythonOutput('ok');
  assert.deepEqual(small, { text: 'ok', truncated: false });
  const big = truncatePythonOutput('x'.repeat(PYTHON_OUTPUT_LIMIT + 10));
  assert.equal(big.truncated, true);
  assert.ok(big.text.includes('已截断'));

  const ok = formatPythonResult({ stdout: 'hi\n', stderr: '', exitCode: 0 });
  assert.deepEqual(ok, { stdout: 'hi\n', stderr: '', exitCode: 0, truncated: false, isError: false });
  const failed = formatPythonResult({ stdout: '', stderr: 'Traceback', exitCode: 1 });
  assert.equal(failed.isError, true);
  assert.equal(formatPythonResult(null).exitCode, 0, '坏输入不抛');
});

test('pythonGateReason：外部根不可用；没打进包不可用；都通过才为空', () => {
  const app = { location: { kind: 'app', uri: '', name: '' } };
  assert.equal(pythonGateReason(app, { pythonAvailable: true }), '');
  assert.equal(pythonGateReason(app, { pythonAvailable: false }), 'NOT_BUNDLED');
  assert.equal(pythonGateReason({ location: { kind: 'saf', uri: 'content://x', name: 'D' } }, { pythonAvailable: true }), 'EXTERNAL_ROOT');
  assert.equal(pythonGateReason(null, { pythonAvailable: true }), '');
});

test('pythonCwdPath：根 + 角色子目录；缺根报错', () => {
  assert.equal(pythonCwdPath('/data/app/workspace/', 'c1'), '/data/app/workspace/c1');
  assert.equal(pythonCwdPath('/data/app/workspace', 'a b/c'), '/data/app/workspace/a_b_c', '角色 id 被 sanitize');
  assert.throws(() => pythonCwdPath('', 'c1'));
});

test('runPythonScript：空代码/无原生模块拒绝；正常路径走注入的原生模块', async () => {
  await assert.rejects(runPythonScript({ code: '   ', cwdPath: '/x', native: { runScript: async () => ({}) } }), /不能为空/);
  await assert.rejects(runPythonScript({ code: 'print(1)', cwdPath: '/x', native: null }), /不含 Python 运行时/);

  const calls = [];
  const native = { runScript: async (code, cwd) => { calls.push({ code, cwd }); return { stdout: '1\n', stderr: '', exitCode: 0 }; } };
  const result = await runPythonScript({ code: 'print(1)', cwdPath: '/data/ws/c1', native });
  assert.deepEqual(calls, [{ code: 'print(1)', cwd: '/data/ws/c1' }]);
  assert.equal(result.stdout, '1\n');
  assert.equal(await isPythonAvailable(), false, 'Node 环境没有原生模块');
});

// 2026-10-08 真机 bug 换来的断言：界面曾把「桥已注册」当「Python 能跑」显示，
// 用户点运行才看到 Chaquopy 的 "Cannot use GenericPlatform on Android" 报错。
// 两者是不同的事——模块注册只说明 APK 带了桥，解释器能不能启动只有原生知道。
test('可用性：必须问原生（isAvailable），不能只看桥是否注册', async () => {
  // 桥注册了但原生说启动失败 → 仍算不可用（这正是真机上发生的情况）
  const registeredButBroken = {
    runScript: async () => ({}),
    isAvailable: async () => false,
  };
  assert.equal(await isPythonAvailable({ native: registeredButBroken }), false,
    '原生报不可用时必须返回 false（旧实现会误报 true）');

  const healthy = { runScript: async () => ({}), isAvailable: async () => true };
  assert.equal(await isPythonAvailable({ native: healthy }), true);

  // 老版本原生没有 isAvailable：不能乐观假定可用，按不可用处理（失败要看得见）
  const legacyNative = { runScript: async () => ({}) };
  assert.equal(await isPythonAvailable({ native: legacyNative }), false,
    '原生缺 isAvailable 时应保守判为不可用');

  // 原生抛错（启动异常）→ 不可用，且不得把异常抛给界面
  const throwing = {
    runScript: async () => ({}),
    isAvailable: async () => { throw new Error('boom'); },
  };
  assert.equal(await isPythonAvailable({ native: throwing }), false);

  // 桥都没注册 → 直接 false，不去调原生
  assert.equal(await isPythonAvailable({ native: null }), false);
  assert.equal(await isPythonAvailable({ native: {} }), false);
});

test('isPythonBridgePresent：只描述「桥是否注册」，与可用性区分开', () => {
  assert.equal(isPythonBridgePresent({ native: { runScript: async () => ({}) } }), true);
  assert.equal(isPythonBridgePresent({ native: {} }), false);
  assert.equal(isPythonBridgePresent({ native: null }), false);
});

// 第三个真机显示问题：面板照「构建时声明」的清单显示「已打进 APK 的依赖」，
// 但最小原型构建跳过了 pip 块，那些包根本不在包里。声明 ≠ 实装，必须向解释器查。
test('实装探测：解析解释器输出，区分已装与缺失', () => {
  const declared = ['requests==2.34.2', 'urllib3==2.8.0', 'idna==3.20'];
  const script = buildPackageProbeScript(declared);
  // 脚本按发行名查（去掉 ==版本），并且不把版本约束带进 importlib.metadata
  assert.ok(script.includes("'requests'") && !script.includes('requests=='), '探测脚本按发行名查');
  assert.ok(script.includes('importlib.metadata'), '用标准库查实装版本');

  const stdout = [
    '__ech2_pkg__\trequests\t2.34.2',
    '__ech2_pkg__\turllib3\t2.8.0',
    '__ech2_pkg__\tidna\t',            // 解释器里没有（版本为空）
    '一些无关的杂项输出',                 // 忽略
  ].join('\n');
  const probed = parsePackageProbe(stdout, declared);
  assert.deepEqual(probed.installed, [
    { name: 'requests', version: '2.34.2' },
    { name: 'urllib3', version: '2.8.0' },
  ]);
  assert.deepEqual(probed.missing, ['idna']);
});

test('实装探测：最小原型构建（一个都没装）如实报告全部缺失', () => {
  const declared = PYTHON_BUNDLED_PACKAGES;
  const stdout = packageNamesOf(declared).map(name => `__ech2_pkg__\t${name}\t`).join('\n');
  const probed = parsePackageProbe(stdout, declared);
  assert.equal(probed.installed.length, 0);
  assert.equal(probed.missing.length, declared.length, '全缺时不能谎报已装');
});

test('probeInstalledPackages：探测失败返回 null（界面回落成「声明」说法）', async () => {
  const declared = ['requests==2.34.2'];
  // 原生不可用
  assert.equal(await probeInstalledPackages({ cwdPath: '/x', packages: declared, native: null }), null);
  // 没有工作目录
  assert.equal(await probeInstalledPackages({ cwdPath: '', packages: declared, native: { runScript: async () => ({}) } }), null);
  // 执行报错
  const failing = { runScript: async () => ({ stdout: '', stderr: 'boom', exitCode: 1 }) };
  assert.equal(await probeInstalledPackages({ cwdPath: '/x', packages: declared, native: failing }), null);
  // 抛异常
  const throwing = { runScript: async () => { throw new Error('x'); } };
  assert.equal(await probeInstalledPackages({ cwdPath: '/x', packages: declared, native: throwing }), null);

  // 正常路径：探测脚本确实被送进原生执行
  const calls = [];
  const ok = {
    runScript: async (code, cwd) => {
      calls.push({ code, cwd });
      return { stdout: '__ech2_pkg__\trequests\t2.34.2', stderr: '', exitCode: 0 };
    },
  };
  const result = await probeInstalledPackages({ cwdPath: '/data/ws/c1', packages: declared, native: ok });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cwd, '/data/ws/c1');
  assert.deepEqual(result.installed, [{ name: 'requests', version: '2.34.2' }]);
});

test('实装探测：包名为空时不生成脚本（不白跑一次解释器）', () => {
  assert.equal(buildPackageProbeScript([]), '');
  assert.equal(buildPackageProbeScript(null), '');
  assert.deepEqual(parsePackageProbe('', []), { installed: [], missing: [] });
});

test('插件纯变换：apply plugin / python 块 / classpath / MainApplication 注册（幂等）', () => {
  const appGradle = [
    'apply plugin: "com.android.application"',
    'android {',
    '    defaultConfig {',
    '        applicationId "com.pppxxxy.easychat2"',
    '    }',
    '}',
  ].join('\n');
  const withPlugin = T.applyChaquopyPlugin(appGradle);
  assert.ok(withPlugin.includes('apply plugin: "com.chaquo.python"'));
  assert.equal(T.applyChaquopyPlugin(withPlugin), withPlugin, '幂等：不重复插入');

  const withConfig = T.applyChaquopyConfig(withPlugin);
  assert.ok(withConfig.includes('buildPython "python3"'));
  assert.ok(withConfig.includes(`install "${PYTHON_BUNDLED_PACKAGES[0]}"`), '构建期依赖来自同一份清单');
  assert.ok(withConfig.includes('abiFilters "arm64-v8a", "x86_64"'));
  // app 内 Python 版本必须显式钉住：不写 version 就吃 Chaquopy 默认值，
  // 换 Chaquopy 版本时 app 内 Python 会悄悄换版，而已装的包未必有对应 wheel。
  assert.ok(withConfig.includes(`version "${T.PYTHON_VERSION}"`), '显式声明 app 内 Python 版本');
  // 依赖必须全部锁版本：不锁则同一份源码在不同时间构建会装到不同版本。
  PYTHON_BUNDLED_PACKAGES.forEach(name => {
    assert.ok(/==[0-9]/.test(name), `依赖必须锁版本号：${name}`);
    assert.ok(withConfig.includes(`install "${name}"`), `pip 块应含 ${name}`);
  });
  assert.equal(T.applyChaquopyConfig(withConfig), withConfig, '幂等');
  // 已有 abiFilters 时不再插一份，避免两处冲突。
  const preFiltered = T.applyChaquopyConfig(`${appGradle}\n    ndk { abiFilters "arm64-v8a" }`);
  assert.equal((preFiltered.match(/abiFilters/g) || []).length, 1);

  const projectGradle = 'buildscript {\n    dependencies {\n    }\n}';
  const withClasspath = T.applyProjectClasspath(projectGradle);
  assert.ok(withClasspath.includes(`classpath("com.chaquo.python:gradle:${T.CHAQUOPY_GRADLE_VERSION}")`));
  assert.equal(T.applyProjectClasspath(withClasspath), withClasspath, '幂等');

  const mainApp = [
    'import expo.modules.ReactNativeHostWrapper',
    'class MainApplication {',
    '  override fun getPackages(): List<ReactPackage> {',
    '    return PackageList(this).packages',
    '  }',
    '}',
  ].join('\n');
  const patched = T.applyMainApplicationPatch(mainApp);
  assert.ok(patched.includes(`import ${T.BRIDGE_PACKAGE}.${T.PACKAGE_CLASS}`));
  assert.ok(patched.includes(`packages.add(${T.PACKAGE_CLASS}())`));
  assert.equal(T.applyMainApplicationPatch(patched), patched, '幂等');
  assert.throws(() => T.applyMainApplicationPatch('class X {}'), /补丁未生效/);
});

// 状态变更（2026-10-08）：原先断言「默认不启用」。用户决定推进启用后，
// 这条的前提失效了——但**不能简单删掉**，因为它守的是「构建失败会不会连累
// 其它功能」这件事。改为断言新的启用姿态：接入 app.json，且第一步是最小原型
// （不装第三方包），这样即使 Gradle 接线有问题，暴露面也只有 Chaquopy 本身。
// 状态变更（2026-10-08，真机第一步通过后）：原先断言「第一步是最小原型
// （minimalPackages:true）」。真机已确认「解释器能启动、print 的输出被捕获、退出码 0」
// （见审查待办「第三次真机往返」），所以第一步的目的（验 Gradle 接线）已达成，
// 现在进入**第二步：装第三方包**（minimalPackages:false ⇒ pip 块带上 5 个包）。
//
// 这条不能只改成 false 了事——它真正守的是「随时能退回最小原型」这个回退能力：
// 第二步若因装包失败，改一个 token 就能回到已知可用的构建。所以下面同时钉住
// 「prop 机制还在」与「pip 块确实按清单生成」。
test('构建姿态：已进入第二步（装第三方包），且保留退回最小原型的能力', () => {
  const appJson = JSON.parse(fs.readFileSync(path.resolve('app.json'), 'utf8'));
  const entry = (appJson.expo.plugins || [])
    .find(item => Array.isArray(item) && String(item[0]).includes('withChaquopy'));
  assert.ok(entry, 'app.json 应挂上 ./plugins/withChaquopy（用户已决定启用）');
  assert.equal(entry[1] && entry[1].minimalPackages, false,
    '第二步：minimalPackages 必须为 false，pip 块才会带上第三方包（第一步已真机通过）');

  const source = fs.readFileSync(path.resolve('plugins/withChaquopy.js'), 'utf8');
  assert.ok(source.includes('没有运行时 pip'), '如实标注无运行时 pip（§2.4 修正）');
  // 回退路径必须还在：装包失败时改回 true（或删掉 app.json 那一项）即可回到可用构建。
  assert.ok(/minimalPackages/.test(source), '插件支持最小原型 prop（回退开关）');
  assert.ok(/minimalPackages \? \{ packages: \[\] \} : \{\}/.test(source),
    'prop 为 true 时必须仍然跳过 pip 块（否则「退回最小原型」是假的）');
  // Kotlin 桥与 Python 辅助模块都在 plugins/chaquopy/ 下（prebuild 时拷进 android/）。
  assert.ok(fs.existsSync(path.resolve('plugins/chaquopy/android/PythonBridgeModule.kt')));
  assert.ok(fs.existsSync(path.resolve('plugins/chaquopy/android/PythonBridgePackage.kt')));
  assert.ok(fs.existsSync(path.resolve('plugins/chaquopy/android/python/easychat2_bridge.py')));
});

test('设置面板接线：Python 小节在，且模型侧不注册 run_python', () => {
  const panel = fs.readFileSync(path.resolve('src/workspace/screen/WorkspaceSettingsPanel.js'), 'utf8');
  const screen = fs.readFileSync(path.resolve('src/workspace/screen/WorkspaceScreen.js'), 'utf8');
  const tools = fs.readFileSync(path.resolve('src/workspace/tools.js'), 'utf8');
  assert.ok(panel.includes('<PythonSection'), '设置面板挂上 Python 小节');
  assert.ok(screen.includes('characterId={characterId}'), '角色 id 传进设置面板');
  // Chaquopy 无法中断脚本 → 不给模型开 run_python（界面里写明了原因）。
  assert.ok(!tools.includes('run_python'), 'agent 工具表里没有 run_python');
  const section = fs.readFileSync(path.resolve('src/workspace/screen/PythonSection.js'), 'utf8');
  assert.ok(section.includes('workspace.python.noKill'), '界面写明「脚本杀不掉、模型不能跑」');
  assert.ok(section.includes('workspace.python.bundled'), '如实展示构建期依赖清单');
});

// ---- Kotlin/Python 源码静态校验（沙箱没有 Kotlin 编译器，先挡纯文本可判定的错误） ----
import { fileURLToPath } from 'node:url';
import {
  checkBraceBalance,
  checkPackageConsistency,
  checkUniqueDeclarations,
  findUnusedImports,
  readAllKotlin,
  readKotlinFiles,
} from './helpers/kotlinStatic.mjs';

const KOTLIN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'chaquopy', 'android');
const KOTLIN_PACKAGE = 'com.pppxxxy.easychat2.pythonbridge';

test('Chaquopy Kotlin 桥：包名一致、大括号平衡、声明唯一、无未使用导入', () => {
  const files = readKotlinFiles(KOTLIN_DIR).map(item => item.file);
  assert.deepEqual(files, ['PythonBridgeModule.kt', 'PythonBridgePackage.kt']);
  assert.deepEqual(checkPackageConsistency(KOTLIN_DIR, KOTLIN_PACKAGE), []);
  for (const { file, source } of readKotlinFiles(KOTLIN_DIR)) {
    const { balance, errors } = checkBraceBalance(source);
    assert.equal(balance, 0, `${file} 大括号不平衡`);
    assert.deepEqual(errors, [], `${file} 有多余的 }`);
    assert.deepEqual(findUnusedImports(source), [], `${file} 有未使用导入`);
  }
  assert.deepEqual(
    checkUniqueDeclarations(readAllKotlin(KOTLIN_DIR), ['class PythonBridgePackage', 'class PythonBridgeModule']),
    [],
    '包类与模块类各自只应定义一次',
  );
});

// 2026-10-08 三次真机往返换来的教训（这一条的前身是**错的**，先说清楚为什么）：
//
// 第一次：release 构建挂在 `:app:compileReleaseKotlin`——原先写的是 `asMap()["stdout"]`，
//   编译不过（asMap() 返回 Map<PyObject, PyObject>，Kotlin 的 Map.get 要求键类型精确
//   匹配：error: Type inference failed: 'K' must be mentioned in input types）。
// 第二次（我当时给的修法是错的）：改成 `result.get("stdout")` 后编译过了，但真机上
//   「退出码 0、没有任何输出」。这回下载 chaquopy_java 16.1.0 的 sources jar 读
//   PyObject.java 才看明白：**PyObject.get 的语义是 getattr()**（javadoc 原文
//   "Equivalent to Python getattr()"，键不存在返回 null 而不抛错）；PyObject 直接当
//   Map 用是**属性访问**，`asMap()` 才是**容器访问**。于是「编译错误」被我换成了
//   「静默错误」——比编译错误更糟，而我当时还把错误形式写成了断言钉死它。
//
// 结论：桥的返回契约**不再依赖 PyObject 的 Map 语义**（属性访问 vs 容器访问是一对陷阱），
// 改成整条 JSON 字符串，跨边界只剩 str() 一种解释。下面的断言钉这件事。
test('Chaquopy 桥：结果走 JSON 字符串契约，不得用 PyObject 的 Map 语义取值', () => {
  const source = fs.readFileSync(path.join(KOTLIN_DIR, 'PythonBridgeModule.kt'), 'utf8');
  // 去掉注释再判，避免把解释这条规则的注释本身当成违规
  const code = source
    .split('\n')
    .filter(line => !line.trim().startsWith('//'))
    .join('\n');

  assert.equal(/\.asMap\(\)/.test(code), false,
    'asMap() 是容器访问但键是 PyObject：字符串键取不到值，Kotlin 还会类型推断失败');
  assert.equal(/\w+\["/.test(code), false,
    '不得对 PyObject 用字符串下标（result["stdout"]）：Kotlin 的 Map.get 键类型必须精确匹配');
  assert.equal(/\.get\("stdout"\)/.test(code), false,
    'PyObject.get 是 getattr()（不是取字典项）：对 dict 取 "stdout" 只会得到 null 且不报错，真机表现为「退出码 0、无输出」');
  assert.ok(/callAttr\("run_code"[^)]*\)\.toString\(\)/.test(code),
    'run_code 的返回值要 .toString()（等价 Python str()）之后再解析');
  assert.ok(/JSONObject\(/.test(code), '用 JSONObject 解析这条 JSON');
  assert.ok(/optString\("stdout"/.test(code) && /optString\("stderr"/.test(code) && /optInt\("exitCode"/.test(code),
    '三个字段都要从 JSON 里取（optString / optInt）');
});

// 字段清单：Kotlin 与 Python 两侧必须一致。跨语言契约最容易「各写各的」——一边改名，
// 另一边静默取空（optString 的默认值会把错误吃掉）。下面的真执行测试会核对这三个键。
const BRIDGE_FIELDS = ['stdout', 'stderr', 'exitCode'];

test('桥的返回契约：Python 侧输出的字段与 Kotlin 侧读取的字段一一对应', () => {
  const py = fs.readFileSync(path.join(KOTLIN_DIR, 'python', 'easychat2_bridge.py'), 'utf8');
  const kt = fs.readFileSync(path.join(KOTLIN_DIR, 'PythonBridgeModule.kt'), 'utf8');
  BRIDGE_FIELDS.forEach(field => {
    assert.ok(py.includes(`"${field}"`), `Python 侧应输出字段 ${field}`);
    assert.ok(kt.includes(`"${field}"`), `Kotlin 侧应读取字段 ${field}`);
  });
});

// 第二个真机 bug（2026-10-08）：APK 装上了、面板显示「可用」，一点运行就报
// "Cannot use GenericPlatform on Android. Call Python.start(new AndroidPlatform(context))
// before using Python"。根因是桥从没启动过解释器——Chaquopy 的 Python.getInstance()
// 在未启动时会自动用 GenericPlatform，而它在 Android 上必然抛异常。
// 这条**编译得过、单测也能过**，只有真机能暴露，所以钉在文本断言上：
// 必须先 ensureStarted()（内部 Python.start(AndroidPlatform(...))）再取实例。
test('Chaquopy 桥：必须先 Python.start(AndroidPlatform) 再使用解释器', () => {
  const source = fs.readFileSync(path.join(KOTLIN_DIR, 'PythonBridgeModule.kt'), 'utf8');
  const code = source
    .split('\n')
    .filter(line => !line.trim().startsWith('//'))
    .join('\n');

  assert.ok(/import com\.chaquo\.python\.android\.AndroidPlatform/.test(code),
    '必须导入 AndroidPlatform（用 GenericPlatform 在 Android 上必炸）');
  assert.ok(/Python\.start\(AndroidPlatform\(reactContext\)\)/.test(code),
    '必须调用 Python.start(AndroidPlatform(reactContext))');
  assert.ok(/Python\.isStarted\(\)/.test(code), '启动前要判 isStarted（start 只能成功一次）');
  // 启动必须幂等且容忍并发：两个线程同时启动时，后到者会收到
  // IllegalStateException("Python already started")——那不是失败。
  assert.ok(/catch \(error: IllegalStateException\)/.test(code),
    '要显式捕获重复启动的 IllegalStateException');
  // 每一处取实例之前都要先确保已启动
  const getInstanceCount = (code.match(/Python\.getInstance\(\)/g) || []).length;
  const ensureCount = (code.match(/ensureStarted\(\)/g) || []).length;
  assert.ok(getInstanceCount > 0, '确实在用 getInstance');
  assert.ok(ensureCount >= getInstanceCount,
    `每处 getInstance 之前都要先 ensureStarted（getInstance ${getInstanceCount} 处，ensureStarted ${ensureCount} 处）`);
});

test('Python 辅助模块：捕获输出、切回原目录、无运行时装包', () => {
  const source = fs.readFileSync(path.join(KOTLIN_DIR, 'python', 'easychat2_bridge.py'), 'utf8');
  assert.ok(source.includes('def run_code('), '导出 run_code');
  assert.ok(source.includes('redirect_stdout') && source.includes('redirect_stderr'), '捕获 stdout/stderr');
  assert.ok(source.includes('traceback.format_exc()'), '异常写进 stderr');
  assert.ok(source.includes('os.chdir(previous)'), '执行后切回原目录');
  // 这两条正则此前是坏的（反斜杠被吞成了 /^\s*import\s+pip/m 的字面残留 /^s*imports+pip/），
  // 匹配不到真实代码，等于永远通过——顺手修掉：断言「没有 import pip / import subprocess
  // 形式的语句」，但允许注释里提到「pip 块」。
  assert.equal(/^\s*import\s+pip\b/m.test(source), false, '不做运行时装包（只允许注释里提到 pip 块）');
  assert.equal(/^\s*import\s+subprocess\b/m.test(source), false, '不起子进程');
  assert.equal(/\bpip\s+install\b/.test(source), false, '不调用 pip install');
});

// ---- 真跑一遍本机 CPython：桥的契约必须真的成立（不只是「文本长得对」） ----
//
// Chaquopy 本体在本环境跑不了（Gradle 级集成），但 easychat2_bridge.py 是纯 Python：
// 只要本机有解释器就能真执行，把「捕获输出 / 异常进 stderr / 输出封顶 / cwd 与还原 /
// JSON 契约」这几件事实测掉。这比文本断言硬得多——真机上「stdout 恒为空」那个问题，
// 若当时有这组测试，会在提交前就红。
//
// 没有解释器时跳过（Node 测试仍要能在无 Python 的机器上跑）。
function findPython() {
  for (const bin of ['python3', 'python', 'py']) {
    try {
      execFileSync(bin, ['-c', 'import sys'], { stdio: 'ignore' });
      return bin;
    } catch (error) {
      // 换下一个候选（Windows 上 python3 常是应用商店的假壳，会直接失败）
    }
  }
  return null;
}

const PYTHON_BIN = findPython();
const BRIDGE_PY_DIR = path.join(KOTLIN_DIR, 'python');
const PYTHON_SKIP = PYTHON_BIN ? false : '本机没有可用的 python 解释器';
const RESULT_MARK = '__ECH2_RESULT__';

// 用子进程驱动桥：代码与路径都从 argv 传（不经 shell、不拼字符串，免掉一层转义风险）。
function runDriver(script, args) {
  const out = execFileSync(PYTHON_BIN, ['-c', script, ...args], {
    encoding: 'utf8',
    // PYTHONDONTWRITEBYTECODE：import 桥模块会在源码目录留 __pycache__，
    // 那是构建产物，不该出现在仓库里（.gitignore 里也有兜底）。
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' },
  });
  const index = out.indexOf(RESULT_MARK);
  assert.ok(index >= 0, `桥没有返回结果（驱动进程输出：${out.slice(0, 300)}）`);
  return JSON.parse(out.slice(index + RESULT_MARK.length));
}

const RUN_CODE_DRIVER = [
  'import sys',
  `sys.path.insert(0, ${JSON.stringify(BRIDGE_PY_DIR)})`,
  'import easychat2_bridge as bridge',
  'payload = bridge.run_code(sys.argv[1], sys.argv[2])',
  `sys.stdout.write(${JSON.stringify(RESULT_MARK)} + payload)`,
].join('\n');

function runBridge(code, cwd = '') {
  return runDriver(RUN_CODE_DRIVER, [code, cwd]);
}

test('Python 桥真执行：print 的输出被确实捕获（真机「有退出码、没输出」那条）', { skip: PYTHON_SKIP }, () => {
  const result = runBridge('print("hello from Python")');
  assert.deepEqual(Object.keys(result).sort(), [...BRIDGE_FIELDS].sort(), 'JSON 的字段就是契约里那三个');
  assert.equal(result.stdout, 'hello from Python\n', 'stdout 必须有内容（这是真机缺的那一块）');
  assert.equal(result.stderr, '');
  assert.equal(result.exitCode, 0);
});

test('Python 桥真执行：异常进 stderr、退出码非 0、崩溃前的输出不丢', { skip: PYTHON_SKIP }, () => {
  const result = runBridge('print("before")\nraise ValueError("boom")');
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, 'before\n');
  assert.ok(result.stderr.includes('ValueError: boom'), 'traceback 要进 stderr');
});

test('Python 桥真执行：stderr 单独捕获，不混进 stdout', { skip: PYTHON_SKIP }, () => {
  const result = runBridge('import sys\nprint("e", file=sys.stderr)');
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'e\n');
});

test('Python 桥真执行：巨量输出被封顶（杀不掉的脚本别把内存吃光）', { skip: PYTHON_SKIP }, () => {
  const result = runBridge('print("x" * 400000)');
  assert.ok(result.stdout.length < 300000, `缓冲必须封顶，实际 ${result.stdout.length} 字符`);
  assert.ok(result.stdout.includes('已在解释器侧截断'), '截断要留标记，不能假装这就是全部');
  assert.equal(result.exitCode, 0);
});

test('Python 桥真执行：代码在给定 cwd 里跑，跑完切回原目录', { skip: PYTHON_SKIP }, () => {
  // 用同一进程内 before/after 对比来验 finally 那一支（分两次进程跑是验不出来的）。
  // 路径比较用 os.path.samefile：Windows 上大小写与 8.3 短名会让字符串比较误判。
  const driver = [
    'import json, os, sys',
    `sys.path.insert(0, ${JSON.stringify(BRIDGE_PY_DIR)})`,
    'import easychat2_bridge as bridge',
    'target = sys.argv[1]',
    'before = os.getcwd()',
    'inside = json.loads(bridge.run_code("import os\\nprint(os.getcwd())", target))["stdout"].strip()',
    'after = os.getcwd()',
    'def same(a, b):',
    '    try:',
    '        return os.path.samefile(a, b)',
    '    except OSError:',
    '        return False',
    'probe = {"inside": inside, "same": same(inside, target), "restored": after == before,',
    '         "after": after, "before": before}',
    `sys.stdout.write(${JSON.stringify(RESULT_MARK)} + json.dumps(probe))`,
  ].join('\n');
  const probe = runDriver(driver, [BRIDGE_PY_DIR]);
  assert.ok(probe.same, `脚本应在给定的 cwd 里执行（Python 报的 cwd：${probe.inside}）`);
  assert.ok(probe.restored, `执行完必须切回原目录（前 ${probe.before} / 后 ${probe.after}）`);
});
