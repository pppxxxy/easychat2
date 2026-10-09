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
  buildPythonEnvPrelude,
  cancelPythonScript,
  createPythonRunner,
  formatPythonResult,
  formatPythonToolResult,
  isPythonAvailable,
  isPythonBridgePresent,
  parsePythonPayload,
  probePython,
  buildPackageProbeScript,
  packageNamesOf,
  parsePackageProbe,
  probeInstalledPackages,
  PYTHON_BUNDLED_PACKAGES,
  PYTHON_OUTPUT_LIMIT,
  PYTHON_WATCHDOG_MS,
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

test('runPythonScript：Node 环境没有原生模块时如实判不可用', async () => {
  assert.equal(await isPythonAvailable(), false, 'Node 环境没有原生模块');
});

// 2026-10-08 真机 bug 换来的断言：界面曾把「桥已注册」当「Python 能跑」显示，
// 用户点运行才看到 Chaquopy 的 "Cannot use GenericPlatform on Android" 报错。
// 两者是不同的事——模块注册只说明 APK 带了桥，解释器能不能启动只有原生知道。
test('可用性：必须问原生（probe），不能只看桥是否注册', async () => {
  // 桥注册了但原生探测失败 → 不可用（这正是真机上发生的情况）
  const registeredButBroken = {
    runScript: async () => '',
    probe: async () => JSON.stringify({ ok: false, pid: 4321, sameProcess: false, error: 'boom' }),
  };
  assert.equal(await isPythonAvailable({ native: registeredButBroken }), false,
    '原生报启动失败时必须返回 false（旧实现会误报 true）');

  const healthy = {
    runScript: async () => '',
    probe: async () => JSON.stringify({ ok: true, pid: 4321, sameProcess: false, error: '' }),
  };
  assert.equal(await isPythonAvailable({ native: healthy }), true);

  // 老版本原生没有 probe：不能乐观假定可用，按不可用处理（失败要看得见）
  const legacyNative = { runScript: async () => '' };
  assert.equal(await isPythonAvailable({ native: legacyNative }), false,
    '原生缺 probe 时应保守判为不可用');

  // 原生抛错（启动异常）→ 不可用，且不得把异常抛给界面
  const throwing = {
    runScript: async () => '',
    probe: async () => { throw new Error('boom'); },
  };
  assert.equal(await isPythonAvailable({ native: throwing }), false);

  // 桥都没注册 → 直接 false，不去调原生
  assert.equal(await isPythonAvailable({ native: null }), false);
  assert.equal(await isPythonAvailable({ native: {} }), false);
});

// 隔离是「模型可以运行 Python」的前提：Chaquopy 没有中断能力，脚本必须跑在
// :python 独立进程里，点「停止」才等于杀掉那个进程。如果 android:process 没生效，
// 服务会落在主进程里——那时「停止」会连 UI 一起杀。所以这种情况**必须判为不可用**，
// 而不是给一个停不下来的执行入口（失败朝安全方向倒）。
test('可用性：隔离没生效（服务在主进程）时必须判为不可用', async () => {
  const sameProcess = {
    runScript: async () => '',
    probe: async () => JSON.stringify({ ok: true, pid: 1, sameProcess: true, error: '' }),
  };
  const probe = await probePython({ native: sameProcess });
  assert.equal(probe.available, false, '同一进程 = 没有隔离，不能算可用');
  assert.equal(probe.reason, 'NOT_ISOLATED', '原因要具体到「隔离没生效」，否则用户不知道该改什么');

  // 隔离生效时把 pid 带回来（排查用）
  const isolated = {
    runScript: async () => '',
    probe: async () => JSON.stringify({ ok: true, pid: 4321, sameProcess: false, error: '' }),
  };
  const ok = await probePython({ native: isolated });
  assert.equal(ok.available, true);
  assert.equal(ok.pid, 4321, 'pid 要带出来，便于排查「服务到底跑在哪」');
});

// 桥的返回契约解析：Python 侧 json.dumps 的一整条 JSON 字符串。
// 为什么不让 dict 跨语言边界：Kotlin 的 PyObject.get 是 getattr() 语义，对 dict 取
// "stdout" 只会得到 null 且不报错——真机表现就是「退出码 0、没有任何输出」。
test('返回契约解析：合法 JSON 通过；空/坏内容要给出可定位的错误', async () => {
  assert.deepEqual(parsePythonPayload('{"stdout":"hi","stderr":"","exitCode":0}'),
    { stdout: 'hi', stderr: '', exitCode: 0 });
  // 带 BOM/前后空白的也能解
  assert.deepEqual(parsePythonPayload('  \n{"a":1}\n '), { a: 1 });

  // 空返回值：说明原生桥与 JS 不匹配（正是「静默出错」那一类），错误也要说清
  assert.throws(() => parsePythonPayload(''), /空结果/);
  assert.throws(() => parsePythonPayload(null), /空结果/);
  // 坏内容：把原文（片段）带进错误里，便于下一轮定位
  assert.throws(() => parsePythonPayload('Cannot use GenericPlatform'), /无法解析/);
  assert.throws(() => parsePythonPayload('[1,2]'), /无法解析/, '数组不是我们要的形状');
});

test('runPythonScript：JSON 契约 → 结构化结果；空代码/无原生模块拒绝', async () => {
  const calls = [];
  const native = {
    runScript: async (code, cwd, timeoutMs) => {
      calls.push({ code, cwd, timeoutMs });
      return JSON.stringify({ stdout: 'ok\n', stderr: '', exitCode: 0 });
    },
  };
  const result = await runPythonScript({ code: 'print(1)', cwdPath: '/ws/c1', timeoutMs: 30000, native });
  assert.deepEqual(calls, [{ code: 'print(1)', cwd: '/ws/c1', timeoutMs: 30000 }]);
  assert.equal(result.stdout, 'ok\n');
  assert.equal(result.isError, false);

  // 退出码非 0 → isError，但仍带回完整输出（模型需要看 traceback）
  const failing = {
    runScript: async () => JSON.stringify({ stdout: 'before\n', stderr: 'ValueError', exitCode: 1 }),
  };
  const bad = await runPythonScript({ code: 'x', cwdPath: '/ws', native: failing });
  assert.equal(bad.isError, true);
  assert.equal(bad.stderr, 'ValueError');
  assert.equal(bad.stdout, 'before\n');

  await assert.rejects(() => runPythonScript({ code: '   ', cwdPath: '/ws', native }), /不能为空/);
  await assert.rejects(() => runPythonScript({ code: 'x', cwdPath: '/ws', native: null }), /不含 Python 运行时/);
});

// 中止语义：用户点「停止」时，必须先请求杀掉 :python 进程再抛中止错误。
// 顺序不能反——反了就是「界面说已停止、脚本还在后台跑」。
test('runPythonScript：signal 中止时先杀进程再抛中止错误', async () => {
  const canceled = [];
  const native = {
    runScript: () => new Promise(() => {}), // 永不返回，模拟卡住的脚本
    cancel: async () => { canceled.push(Date.now()); },
  };
  const controller = new AbortController();
  const pending = runPythonScript({ code: 'while True: pass', cwdPath: '/ws', signal: controller.signal, native });
  controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError' && error.canceled === true);
  assert.equal(canceled.length, 1, '中止时必须请求原生杀掉 :python 进程');

  // 已经中止的 signal 直接拒绝，连原生都不进
  const abortController = new AbortController();
  abortController.abort();
  await assert.rejects(
    () => runPythonScript({ code: 'x', cwdPath: '/ws', signal: abortController.signal, native }),
    error => error.name === 'AbortError'
  );
});

test('isPythonBridgePresent：只描述「桥是否注册」，与可用性区分开', () => {
  assert.equal(isPythonBridgePresent({ native: { runScript: async () => '' } }), true);
  assert.equal(isPythonBridgePresent({ native: {} }), false);
  assert.equal(isPythonBridgePresent({ native: null }), false);
});

test('cancelPythonScript：原生缺失/抛错时返回 false，不把异常抛给界面', async () => {
  assert.equal(await cancelPythonScript({ native: null }), false);
  assert.equal(await cancelPythonScript({ native: {} }), false);
  assert.equal(await cancelPythonScript({ native: { cancel: async () => { throw new Error('x'); } } }), false);
  assert.equal(await cancelPythonScript({ native: { cancel: async () => {} } }), true);
});

// 工具用的运行器（模型走的就是这条）：固定看门狗、输出转成给模型读的文本。
// 看门狗必须是**工具自己设**的：模型调用不能等用户来点停止。
test('createPythonRunner：固定看门狗、结果转成模型可读文本、走角色沙盒目录', async () => {
  const calls = [];
  const native = {
    runScript: async (code, cwd, timeoutMs) => {
      calls.push({ code, cwd, timeoutMs });
      return JSON.stringify({ stdout: '42\n', stderr: '', exitCode: 0 });
    },
  };
  const runner = createPythonRunner({ sandboxRoot: '/data/ws', native });
  const result = await runner({ code: 'print(6*7)', characterId: 'c1' });
  assert.deepEqual(calls, [{ code: 'print(6*7)', cwd: '/data/ws/c1', timeoutMs: PYTHON_WATCHDOG_MS }],
    '工作目录是角色沙盒，且看门狗由工具固定设置');
  assert.equal(result.isError, false);
  assert.ok(result.content.includes('退出码：0'));
  assert.ok(result.content.includes('42'));

  // 出错时：isError 为真，且 traceback 要原样交给模型（它得据此改代码）
  const failing = createPythonRunner({
    sandboxRoot: '/data/ws',
    native: { runScript: async () => JSON.stringify({ stdout: '', stderr: 'ZeroDivisionError', exitCode: 1 }) },
  });
  const bad = await failing({ code: '1/0', characterId: 'c1' });
  assert.equal(bad.isError, true);
  assert.ok(bad.content.includes('ZeroDivisionError'));

  // 无输出时也要给一句明确的话，不要交回空字符串（模型会以为工具坏了）
  const quiet = createPythonRunner({
    sandboxRoot: '/data/ws',
    native: { runScript: async () => JSON.stringify({ stdout: '', stderr: '', exitCode: 0 }) },
  });
  assert.ok((await quiet({ code: 'pass', characterId: 'c1' })).content.includes('（无输出）'));
});

test('formatPythonToolResult：截断后仍如实标注，退出码非 0 即错误', () => {
  const huge = 'x'.repeat(PYTHON_OUTPUT_LIMIT + 100);
  const formatted = formatPythonResult({ stdout: huge, stderr: '', exitCode: 0 });
  assert.equal(formatted.truncated, true);
  assert.ok(formatted.stdout.includes('输出已截断'));
  const tool = formatPythonToolResult(formatted);
  assert.ok(tool.content.includes('输出已截断'), '给模型的文本也要带上截断说明');
  assert.equal(formatPythonToolResult({ stdout: '', stderr: 'e', exitCode: 2 }).isError, true);
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
  assert.equal(await probeInstalledPackages({ cwdPath: '', packages: declared, native: { runScript: async () => '{}' } }), null);
  // 执行报错
  const failing = { runScript: async () => JSON.stringify({ stdout: '', stderr: 'boom', exitCode: 1 }) };
  assert.equal(await probeInstalledPackages({ cwdPath: '/x', packages: declared, native: failing }), null);
  // 抛异常
  const throwing = { runScript: async () => { throw new Error('x'); } };
  assert.equal(await probeInstalledPackages({ cwdPath: '/x', packages: declared, native: throwing }), null);

  // 正常路径：探测脚本确实被送进原生执行
  const calls = [];
  const ok = {
    runScript: async (code, cwd) => {
      calls.push({ code, cwd });
      return JSON.stringify({ stdout: '__ech2_pkg__\trequests\t2.34.2', stderr: '', exitCode: 0 });
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

// 状态变更（2026-10-08，隔离做完后）：这条原先断言「agent 工具表里没有 run_python」。
// 当时不给模型开的原因只有一个——脚本杀不掉。隔离做完（:python 进程 + 看门狗 + 停止按钮）
// 之后这个前提不再成立，所以改为断言**新的门控姿态**：工具存在，但必须有独立开关、
// 必须逐条确认、必须绑定超时；而且界面里的旧说法（「模型不能跑」）必须已经改口，
// 否则用户会照旧文案理解现在的行为。
test('设置面板接线：Python 小节在；run_python 存在但被三层门控关住', () => {
  const panel = fs.readFileSync(path.resolve('src/workspace/screen/WorkspaceSettingsPanel.js'), 'utf8');
  const screen = fs.readFileSync(path.resolve('src/workspace/screen/WorkspaceScreen.js'), 'utf8');
  // 定义在 execTools.js（质量建议 ① 后按域拆分）；超时表仍在索引层 tools.js。
  const execDefs = fs.readFileSync(path.resolve('src/workspace/toolDefs/execTools.js'), 'utf8');
  const tools = fs.readFileSync(path.resolve('src/workspace/tools.js'), 'utf8');
  assert.ok(panel.includes('<PythonSection'), '设置面板挂上 Python 小节');
  assert.ok(screen.includes('characterId={characterId}'), '角色 id 传进设置面板');

  // 工具定义本身：独立开关 + 逐条确认 + 更长超时（模型调用会自我了断）
  assert.ok(execDefs.includes("name: 'run_python'"), 'agent 工具表里有 run_python');
  const pythonTool = execDefs.slice(execDefs.indexOf("name: 'run_python'"));
  assert.ok(pythonTool.includes('requiresConfirmation: true'), 'run_python 必须逐条确认');
  assert.ok(/PYTHON_TOOL_TIMEOUT_MS/.test(tools), 'run_python 要用自己的（更长）工具超时（超时表在索引层）');

  // 界面：不能还写着「模型不能运行 Python」（那是隔离之前的说法）
  const section = fs.readFileSync(path.resolve('src/workspace/screen/PythonSection.js'), 'utf8');
  assert.ok(!section.includes('noKill'), '旧文案 noKill 必须移除（它说的是隔离之前的行为）');
  assert.ok(section.includes('workspace.python.isolation'), '界面改口为「跑在独立进程、可停止」');
  assert.ok(section.includes('workspace.python.bundled'), '如实展示构建期依赖清单');
  assert.ok(section.includes('workspace.python.stop'), '界面要有「停止」（既然是独立进程，就能停）');
});

// ---- Kotlin/Python 源码静态校验（沙箱没有 Kotlin 编译器，先挡纯文本可判定的错误） ----
import { fileURLToPath } from 'node:url';
import {
  checkBraceBalance,
  stripComments,
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
  assert.deepEqual(files, ['PythonBridgeModule.kt', 'PythonBridgePackage.kt', 'PythonService.kt']);
  assert.deepEqual(checkPackageConsistency(KOTLIN_DIR, KOTLIN_PACKAGE), []);
  for (const { file, source } of readKotlinFiles(KOTLIN_DIR)) {
    const { balance, errors } = checkBraceBalance(source);
    assert.equal(balance, 0, `${file} 大括号不平衡`);
    assert.deepEqual(errors, [], `${file} 有多余的 }`);
    assert.deepEqual(findUnusedImports(source), [], `${file} 有未使用导入`);
  }
  assert.deepEqual(
    checkUniqueDeclarations(readAllKotlin(KOTLIN_DIR), [
      'class PythonBridgePackage',
      'class PythonBridgeModule',
      'class PythonService',
    ]),
    [],
    '包类、模块类与服务类各自只应定义一次',
  );
});

// 隔离（本来想用 AIDL，改成了 Messenger）。这套方案的**唯一**理由：Chaquopy 没有
// 中断/强杀解释器的 API（16.1.0 的 chaquopy_java 源码里 grep 不到 interrupt/kill/
// abort/cancel），同进程里唯一能停掉跑飞脚本的办法是杀掉整个应用进程。所以脚本必须
// 在 :python 里跑，而且**解释器的启动只能在服务里**——两处启动会各自解压标准库、
// 各自持有解释器状态，且主进程那份仍然杀不掉。
test('隔离：解释器只在 :python 服务里启动，桥模块只做绑定调用', () => {
  const service = fs.readFileSync(path.join(KOTLIN_DIR, 'PythonService.kt'), 'utf8');
  const module = fs.readFileSync(path.join(KOTLIN_DIR, 'PythonBridgeModule.kt'), 'utf8');
  const code = source => stripComments(source);

  // 服务里必须有启动逻辑，且必须是 AndroidPlatform（GenericPlatform 在 Android 上必炸）
  assert.ok(/Python\.start\(AndroidPlatform\(/.test(code(service)),
    '服务里要 Python.start(AndroidPlatform(...))');
  assert.ok(/Python\.isStarted\(\)/.test(code(service)), '启动前要判 isStarted（start 只成功一次）');
  assert.ok(/ensureStarted\(\)/.test(code(module) + code(service)), '要有幂等的 ensureStarted');

  // 桥模块**不得**再启动解释器：一旦它自己 start，隔离就形同虚设
  assert.equal(/Python\.start\(/.test(code(module)), false,
    '桥模块不得自己启动解释器——启动只能发生在 :python 服务里，否则脚本又回到主进程');
  assert.equal(/Python\.getInstance\(\)/.test(code(module)), false,
    '桥模块不得取解释器实例（那正是「同进程」的老路）');

  // 服务必须靠 Process.killProcess 自杀来实现「停止」——这是唯一的停止手段
  assert.ok(/Process\.killProcess\(Process\.myPid\(\)\)/.test(code(service)),
    '服务必须用 Process.killProcess 结束自己（这是唯一能停掉脚本的办法）');
  // 「先回消息再杀进程」：Messenger 的 send 是同步 Binder 调用，消息在 send 返回前已
  // 落到对端队列，所以紧接着自杀不会把「为什么被杀」弄丢。顺序反了用户就只看到断开。
  const killIndex = code(service).indexOf('Process.killProcess');
  const sendBeforeKill = code(service).lastIndexOf('send(reply', killIndex);
  assert.ok(sendBeforeKill > 0, '杀进程前要先 send 一条说明（否则客户端只看到绑定断开、不知道原因）');
  // 空闲时点停止不能误杀：那时 running 为 false，服务应如实回「本来就没在跑」
  assert.ok(/if \(!running\)/.test(code(service)), '空闲时收到取消不能自杀（否则下次运行要重新起进程）');
});

// 客户端侧：跨进程通信 + pid 校验。pid 相同 = 隔离没生效，必须**拒绝执行**而不是
// 假装能跑（那时「停止」会杀掉 UI 进程）。
test('隔离：客户端用 Messenger 跨进程通信，并在 pid 相同（未隔离）时拒绝执行', () => {
  const module = fs.readFileSync(path.join(KOTLIN_DIR, 'PythonBridgeModule.kt'), 'utf8');
  const code = stripComments(module);

  assert.ok(/Messenger\(/.test(code), '用 Messenger 通信（不需要 AIDL 与 Gradle buildFeatures 改动）');
  assert.ok(/bindService\(/.test(code) && /unbindService\(/.test(code), '绑定与解绑成对');
  assert.ok(/BIND_AUTO_CREATE/.test(code), '无 root 的 shell...');
  assert.ok(/Process\.myPid\(\)/.test(code), '要拿自己的 pid 与服务 pid 比对');
  assert.ok(/python_not_isolated/.test(code), 'pid 相同（未隔离）时要明确拒绝，而不是照跑');
  // 超时上限：JS 传天文数字等于没有上限
  assert.ok(/MAX_TIMEOUT_MS/.test(code), '原生侧要有超时硬上限');

  // 两个时序问题——都不需要真机就能判定，且只有文本断言能挡（Kotlin 在本环境编不了）：
  // 1) 进程被杀（超时/中止）后绑定仍有效，系统可能把服务重新拉起并**再次**回调
  //    onServiceConnected。不判 settled 就会把脚本发第二遍——模型给的代码可能有副作用
  //    （写文件、发网络请求），跑两次不是「多此一举」而是错。停脚本这条链路上必现。
  // 2) running 由 worker 线程写、主线程（看门狗/取消）读，两者之间没有同步边，
  //    不加 @Volatile 就是数据竞争：可能表现为看门狗误杀刚跑完的脚本，或点停止没反应。
  const connectedBody = code.slice(
    code.indexOf('override fun onServiceConnected'),
    code.indexOf('override fun onServiceDisconnected'),
  );
  assert.ok(connectedBody.length > 0, '找得到 onServiceConnected 的实现');
  assert.ok(/if \(settled\)/.test(connectedBody),
    'onServiceConnected 必须先判 settled（服务被重新拉起时会再回调一次，重发 = 脚本跑第二次）');
  const serviceCode = stripComments(fs.readFileSync(path.join(KOTLIN_DIR, 'PythonService.kt'), 'utf8'));
  assert.ok(/@Volatile\s+private\s+var\s+running/.test(serviceCode),
    'running 必须 @Volatile：worker 线程写、主线程读，没有同步边');
});

// 服务声明必须真的写进清单——**验的是函数输出，不是源码里有没有这行字**。
// 这条一开始写成「源码里出现 android:process 就算过」，注入验证时发现它抓不住
// 「把声明行删掉」：注释里还留着这几个字，断言照样通过（装饰性断言的典型症状）。
// 改成对 applyServiceDeclaration 的返回值断言，删掉声明行就必红。
test('服务声明：清单里必须带上 android:process=":python" 且不导出', () => {
  const manifest = { application: [{ $: { 'android:name': '.MainApplication' } }] };
  const declared = T.applyServiceDeclaration(manifest);
  const services = declared.application[0].service;
  assert.equal(services.length, 1, '应当声明一个服务');
  const service = services[0].$;
  assert.equal(service['android:name'], `${T.BRIDGE_PACKAGE}.${T.SERVICE_CLASS}`);
  assert.equal(service['android:process'], ':python',
    '必须写 android:process：漏了它服务就跑在主进程里，「停止」会杀掉 UI 进程');
  assert.equal(service['android:exported'], 'false',
    '服务必须不导出（导出等于把「执行 Python 代码」变成外部可调用的入口）');

  // 幂等：重复执行不得追加第二个服务声明
  const again = T.applyServiceDeclaration(declared);
  assert.equal(again.application[0].service.length, 1, '幂等：不重复声明');
  assert.equal(again.application[0].service[0].$['android:process'], ':python');
  // 已有声明但缺 process 时（旧版本留下的）要补上，而不是当成「已存在」跳过
  const legacy = { application: [{ service: [{ $: { 'android:name': `${T.BRIDGE_PACKAGE}.${T.SERVICE_CLASS}` } }] }] };
  assert.equal(T.applyServiceDeclaration(legacy).application[0].service[0].$['android:process'], ':python',
    '已存在的声明缺 process 也要补上（否则隔离静默失效）');
  // 没有 application 节点要明确报错，而不是静默跳过
  assert.throws(() => T.applyServiceDeclaration({}), /找不到 application/);
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
//
// 注意这条要同时扫两个文件：取值已经挪到服务里（module 只搬字符串），只扫 module
// 会让「谁把 PyObject 取值写回去」漏网。
test('Chaquopy 桥：结果走 JSON 字符串契约，不得用 PyObject 的 Map 语义取值', () => {
  const sources = ['PythonBridgeModule.kt', 'PythonService.kt'].map(file => {
    const source = fs.readFileSync(path.join(KOTLIN_DIR, file), 'utf8');
    // 去掉注释再判，避免把解释这条规则的注释本身当成违规
    return { file, code: stripComments(source) };
  });

  for (const { file, code } of sources) {
    assert.equal(/\.asMap\(\)/.test(code), false,
      `${file}：asMap() 是容器访问但键是 PyObject：字符串键取不到值，Kotlin 还会类型推断失败`);
    assert.equal(/\w+\["/.test(code), false,
      `${file}：不得对 PyObject 用字符串下标（result["stdout"]）`);
    assert.equal(/\.get\("stdout"\)/.test(code), false,
      `${file}：PyObject.get 是 getattr()，对 dict 取 "stdout" 只会得到 null 且不报错`);
  }

  const service = sources.find(item => item.file === 'PythonService.kt').code;
  assert.ok(/callAttr\("run_code"[^)]*\)\.toString\(\)/.test(service),
    'run_code 的返回值要 .toString()（等价 Python str()）后再交给客户端');
  // 服务内部用不带前缀的 KEY_PAYLOAD（companion 常量），客户端才写 PythonService.KEY_PAYLOAD
  assert.ok(/putString\((?:PythonService\.)?KEY_PAYLOAD/.test(service), '结果整条作为 payload 传回');

  // 解析在 JS 侧做（能单测，也能把「返回了什么」写进错误里）——所以 Kotlin 侧不应
  // 出现 JSONObject 解析字段：一旦两边都解析，契约就有了两个真相。
  assert.equal(/JSONObject\(/.test(service), false, 'Kotlin 侧不解析 Python 的结果 JSON（在 JS 侧做）');
});

// 字段清单：Python 侧产出、JS 侧解析——两侧必须一致。跨语言契约最容易「各写各的」：
// 一边改名，另一边取到 undefined 却不报错（真机踩过「退出码 0、无输出」那一类），
// 所以要逐个字段核对。Kotlin 侧只是把整条字符串搬过去，不参与解析（见上一条）。
const BRIDGE_FIELDS = ['stdout', 'stderr', 'exitCode'];

test('桥的返回契约：Python 侧输出的字段与 JS 侧读取的字段一一对应', () => {
  const py = fs.readFileSync(path.join(KOTLIN_DIR, 'python', 'easychat2_bridge.py'), 'utf8');
  const js = fs.readFileSync(path.resolve('src/workspace/python.js'), 'utf8');
  BRIDGE_FIELDS.forEach(field => {
    assert.ok(py.includes(`"${field}"`), `Python 侧应输出字段 ${field}`);
    assert.ok(js.includes(`source.${field}`), `JS 侧应读取字段 ${field}`);
  });
});

// 第二个真机 bug（2026-10-08）：APK 装上了、面板显示「可用」，一点运行就报
// "Cannot use GenericPlatform on Android. Call Python.start(new AndroidPlatform(context))
// before using Python"。根因是桥从没启动过解释器——Chaquopy 的 Python.getInstance()
// 在未启动时会自动用 GenericPlatform，而它在 Android 上必然抛异常。
// 这条**编译得过、单测也能过**，只有真机能暴露，所以钉在文本断言上：
// 必须先 ensureStarted()（内部 Python.start(AndroidPlatform(...))）再取实例。
// 现在启动发生在 :python 服务里（见上面的隔离断言）。
test('Chaquopy 服务：必须先 Python.start(AndroidPlatform) 再使用解释器', () => {
  const source = fs.readFileSync(path.join(KOTLIN_DIR, 'PythonService.kt'), 'utf8');
  const code = stripComments(source);

  assert.ok(/import com\.chaquo\.python\.android\.AndroidPlatform/.test(code),
    '必须导入 AndroidPlatform（用 GenericPlatform 在 Android 上必炸）');
  assert.ok(/Python\.start\(AndroidPlatform\(/.test(code),
    '必须调用 Python.start(AndroidPlatform(...))');
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

// 串行执行：解释器是单例，`os.chdir` 与 `sys.stdout` 重定向都是**进程级全局状态**，
// 并发跑会互相踩（一个脚本的重定向截走另一个的输出）。所以服务必须拒绝第二个并发请求，
// 而且要明说「上一个还在跑」，不能静默排队或静默丢弃。
test('Chaquopy 服务：脚本串行执行，并发请求要明确回绝', () => {
  const source = fs.readFileSync(path.join(KOTLIN_DIR, 'PythonService.kt'), 'utf8');
  const code = stripComments(source);
  assert.ok(/if \(running\)/.test(code), '要检查是否已有脚本在跑');
  assert.ok(/ERROR_BUSY/.test(code), '并发请求要回一条明确的「忙」错误');
  // 看门狗：kill 之前要先清掉自己，避免刚好卡在超时边界上把已完成的运行杀掉。
  assert.ok(/clearWatchdog\(\)/.test(code), '要有看门狗清理（否则会误杀刚跑完的脚本）');
  assert.ok(/postDelayed/.test(code) && /removeCallbacks/.test(code), '看门狗要能设也要能撤');
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

// ---- BUG-4（审查报告）：env.json 的环境变量必须对 run_python 也生效 ----
//
// shell 侧早已注入（shell.js 的 wrapShellCommand），run_python 此前完全不读这份会话：
// 用户在 env.json 配的变量，shell 里 echo 有值、Python 里直接 KeyError。
// 同一个「工作区会话」状态，两种执行器读法必须一致。
test('buildPythonEnvPrelude：空 env 不产出任何前缀（脚本逐字节不变）', () => {
  assert.equal(buildPythonEnvPrelude({}), '');
  assert.equal(buildPythonEnvPrelude(null), '');
  assert.equal(buildPythonEnvPrelude([]), '');
  assert.equal(buildPythonEnvPrelude({ '  ': 'x' }), '', '空键不算');

  const prelude = buildPythonEnvPrelude({ FOO: 'bar', N: 42 });
  assert.match(prelude, /^import os\nos\.environ\.update\(/);
  assert.match(prelude, /"FOO":"bar"/);
  assert.match(prelude, /"N":"42"/, '非字符串值统一成字符串（环境变量只能是字符串）');
});

// 真跑一遍：把 prelude 写成临时 .py 交给本机 CPython 执行，验证**转义真的对**——
// 引号 / 反斜杠 / 换行 / 制表符 / 中文这些最容易写错的地方，靠文本断言看不出来。
test('buildPythonEnvPrelude：注入的值在真解释器里逐字节还原（含引号/反斜杠/换行/中文）', { skip: PYTHON_SKIP }, () => {
  const env = {
    QUOTE: 'he said "hi" and \'bye\'',
    SLASH: 'C:\path\to\file',
    NEWLINE: 'line1\nline2',
    TAB: 'a\tb',
    CN: '中文·值',
    EMPTY: '',
  };
  const dir = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'ech2-env-'));
  try {
    const script = `${buildPythonEnvPrelude(env)}
import json, os, sys
sys.stdout.write(json.dumps({key: os.environ.get(key, '<missing>') for key in ${JSON.stringify(Object.keys(env))}}, ensure_ascii=False))
`;
    const file = path.join(dir, 'probe.py');
    fs.writeFileSync(file, script, 'utf8');
    const out = execFileSync(PYTHON_BIN, [file], {
      encoding: 'utf8',
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    assert.deepEqual(JSON.parse(out), env, '注入的每个值都必须原样出现在 os.environ');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createPythonRunner：有 store 时注入会话 env，无 store 时脚本原样', async () => {
  const sent = [];
  const native = {
    runScript: async (code, cwd, timeoutMs) => {
      sent.push({ code, cwd, timeoutMs });
      return JSON.stringify({ stdout: '', stderr: '', exitCode: 0 });
    },
  };
  // 假 store：只有 .easychat/env.json 这一个文件
  const store = {
    readWorkspaceFile: async ({ path: filePath }) => {
      if (filePath !== '.easychat/env.json') throw new Error('ENOENT');
      return { content: JSON.stringify({ cwd: '', env: { WORKSPACE_MODE: 'dev' } }) };
    },
    writeWorkspaceFile: async () => true,
  };

  const withStore = createPythonRunner({ sandboxRoot: '/data/ws', native, store });
  await withStore({ code: 'print("hi")', characterId: 'c1' });
  assert.match(sent[0].code, /os\.environ\.update\(\{"WORKSPACE_MODE":"dev"\}\)/, '会话变量必须注入');
  assert.ok(sent[0].code.endsWith('print("hi")'), '原脚本必须原样跟在后面（不被改写）');

  const withoutStore = createPythonRunner({ sandboxRoot: '/data/ws', native });
  await withoutStore({ code: 'print("hi")', characterId: 'c1' });
  assert.equal(sent[1].code, 'print("hi")', '无 store 时脚本逐字节不变（行为不回退）');

  // 会话文件缺失/坏掉：静默不注入，绝不能因此让脚本跑不了
  const brokenStore = { readWorkspaceFile: async () => { throw new Error('boom'); } };
  const broken = createPythonRunner({ sandboxRoot: '/data/ws', native, store: brokenStore });
  await broken({ code: 'print("hi")', characterId: 'c1' });
  assert.equal(sent[2].code, 'print("hi")');
});
