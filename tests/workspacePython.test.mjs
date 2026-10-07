// Python 环境（Chaquopy，T2）：JS 纯逻辑 + 预构建插件的纯变换。
//
// 默认不启用（app.json 不挂 withChaquopy）——Gradle 级集成只能靠真机 APK 构建验证，
// 默认打开会让「下一次构建」成为唯一验证手段、失败还连带阻塞其它功能。这里断言的就是
// 「默认关闭 + 启用方式有文档 + 纯变换正确」。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

import {
  formatPythonResult,
  isPythonAvailable,
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
  assert.equal(isPythonAvailable(), false, 'Node 环境没有原生模块');
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

test('默认不启用：app.json 不挂 withChaquopy；启用方式写在插件头部', () => {
  const appJson = JSON.parse(fs.readFileSync(path.resolve('app.json'), 'utf8'));
  const plugins = (appJson.expo.plugins || []).map(item => (Array.isArray(item) ? item[0] : item));
  assert.equal(plugins.some(name => String(name).includes('withChaquopy')), false,
    '默认关闭：Gradle 集成只能靠真机构建验证，默认打开会阻塞其它功能');
  const source = fs.readFileSync(path.resolve('plugins/withChaquopy.js'), 'utf8');
  assert.ok(source.includes('默认不启用'), '插件头部说明默认关闭与启用方式');
  assert.ok(source.includes('"./plugins/withChaquopy"'), '给出确切的启用写法');
  assert.ok(source.includes('没有运行时 pip'), '如实标注无运行时 pip（§2.4 修正）');
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

test('Python 辅助模块：捕获输出、切回原目录、无运行时装包', () => {
  const source = fs.readFileSync(path.join(KOTLIN_DIR, 'python', 'easychat2_bridge.py'), 'utf8');
  assert.ok(source.includes('def run_code('), '导出 run_code');
  assert.ok(source.includes('redirect_stdout') && source.includes('redirect_stderr'), '捕获 stdout/stderr');
  assert.ok(source.includes('traceback.format_exc()'), '异常写进 stderr');
  assert.ok(source.includes('os.chdir(previous)'), '执行后切回原目录');
  assert.ok(!/^s*imports+pip/m.test(source) && !/pips+install/.test(source), '不做运行时装包（只允许注释里提到 pip 块）');
  assert.ok(!/^s*imports+subprocess/m.test(source), '不起子进程');
});
