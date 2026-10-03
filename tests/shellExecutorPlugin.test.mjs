// 命令执行插件的静态校验（复用 kotlinStatic 的文本层检查）。
//
// 沙箱与 CI 的 JS 环境都没有 Kotlin 编译器，原生代码的语法错误只能在 Gradle
// 构建阶段暴露。这里把「大括号平衡、包名一致、顶层声明唯一、未使用导入」这些
// 纯文本可判定的错误提前挡下来（与 localApiServerPlugin.test.mjs 同一套工具）。
//
// 另外这组断言还钉住几条**功能约束**，它们只写在 Kotlin 注释里很容易被改掉，
// 但每一条都对应一个真实会踩的坑（写满管道死锁、超时不强杀、中止杀不掉）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  checkBraceBalance,
  checkPackageConsistency,
  checkUniqueDeclarations,
  findUnusedImports,
  readAllKotlin,
  readKotlinFiles,
} from './helpers/kotlinStatic.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const KOTLIN_DIR = path.join(HERE, '..', 'plugins', 'shellExecutor', 'android');
const KOTLIN_PACKAGE = 'com.pppxxxy.easychat2.shellexecutor';

const plugin = require('../plugins/withShellExecutor.js');
const {
  PERMISSIONS,
  PACKAGE_CLASS,
  SHELL_PACKAGE,
  applyGradleDependencies,
  applyMainApplicationPatch,
} = plugin.__testables;

function readModule() {
  return readKotlinFiles(KOTLIN_DIR).find(item => item.file === 'ShellExecutorModule.kt').source;
}

test('Kotlin 源码存在且包名一致', () => {
  const files = readKotlinFiles(KOTLIN_DIR).map(item => item.file);
  assert.deepEqual(files, ['ShellExecutorModule.kt', 'ShellExecutorPackage.kt']);
  assert.deepEqual(checkPackageConsistency(KOTLIN_DIR, KOTLIN_PACKAGE), []);
});

test('Kotlin 大括号平衡、顶层声明唯一、无未使用导入', () => {
  for (const { file, source } of readKotlinFiles(KOTLIN_DIR)) {
    const { balance, errors } = checkBraceBalance(source);
    assert.equal(balance, 0, `${file} 大括号不平衡`);
    assert.deepEqual(errors, [], `${file} 有多余的 }`);
    assert.deepEqual(findUnusedImports(source), [], `${file} 有未使用导入`);
  }
  const all = readAllKotlin(KOTLIN_DIR);
  assert.deepEqual(
    checkUniqueDeclarations(all, [`class ${PACKAGE_CLASS}`, 'class ShellExecutorModule']),
    [],
    '包类与模块类各自只应定义一次',
  );
});

test('该模块不需要任何 Manifest 权限（起子进程不涉及权限）', () => {
  assert.deepEqual(PERMISSIONS, []);
  assert.equal(SHELL_PACKAGE, 'com.pppxxxy.easychat2.shellexecutor');
  assert.equal(PACKAGE_CLASS, 'ShellExecutorPackage');
});

test('MainApplication 补丁注册 ShellExecutorPackage 且幂等（两种 SDK 模板）', () => {
  for (const input of [
    [
      'import expo.modules.ReactNativeHostWrapper',
      '',
      '          override fun getPackages(): List<ReactPackage> {',
      '            return PackageList(this).packages',
      '          }',
    ].join('\n'),
    [
      'import expo.modules.ReactNativeHostWrapper',
      '',
      '    override fun getPackages(): List<ReactPackage> =',
      '        PackageList(this).packages.apply {',
      '        }',
    ].join('\n'),
  ]) {
    const once = applyMainApplicationPatch(input);
    assert.match(once, new RegExp(`import com\\.pppxxxy\\.easychat2\\.shellexecutor\\.${PACKAGE_CLASS}`));
    assert.match(once, new RegExp(`add\\(${PACKAGE_CLASS}\\(\\)\\)`));
    assert.equal(applyMainApplicationPatch(once), once, '重复应用必须幂等');
  }
});

test('MainApplication 两处模板都不认识时明确抛错（不静默漏注册）', () => {
  assert.throws(
    () => applyMainApplicationPatch('import expo.modules.ReactNativeHostWrapper\n'),
    /MainApplication 补丁未生效/,
  );
});

test('Gradle 依赖补丁对本模块无操作（幂等，便于与 localApiServer 结构对齐）', () => {
  const input = 'dependencies {\n}\n';
  assert.equal(applyGradleDependencies(input), input);
});

test('原生实现必须守住四条硬约束（每条都对应一个真实故障）', () => {
  const source = readModule();

  // 1. sh 的绝对路径调用，且工作目录来自 JS 传入的沙盒（不写死任何路径）
  assert.ok(source.includes('ProcessBuilder("/system/bin/sh", "-c", trimmed)'), '必须走 /system/bin/sh -c');
  assert.ok(source.includes('builder.directory(directory)'), '工作目录必须限定在传入的沙盒');
  assert.ok(source.includes('cwdPath.startsWith("/")'), '工作目录必须是绝对路径');

  // 2. stdout/stderr 并发读取：单线程顺序读会在 64KB 管道缓冲处死锁
  assert.ok(/outThread\.start\(\)[\s\S]{0,80}errThread\.start\(\)/.test(source),
    '必须并发启动两条读取线程（否则管道写满即死锁）');

  // 3. 输出上限：超限继续读但不累积，避免 yes 之类把内存吃光
  assert.ok(source.includes('OUTPUT_LIMIT'), '必须有输出上限');
  assert.ok(/if \(builder\.length < limit\)/.test(source), '超限后仍要继续排空管道');

  // 4. 超时与中止都要强杀：destroy() 只发 SIGTERM，sh 的子孙进程可能不理它
  assert.ok(source.includes('destroyForcibly()'), '超时/中止必须强杀');
  assert.ok(/fun kill\(requestId: String/.test(source), '必须能按 requestId 精确终止');
  assert.ok(source.includes('running.remove(key)'), '终止要从运行表移除，避免句柄泄漏');
  assert.ok(source.includes('onCatalystInstanceDestroy'), 'JS 实例销毁时不能留下孤儿进程');
});

test('原生实现把执行放到后台线程（不阻塞 RN 线程）', () => {
  const source = readModule();
  assert.ok(/Thread \{[\s\S]{0,4000}?\}\.start\(\)/.test(source), 'exec 必须跑在自己的线程上');
  assert.ok(source.includes('promise.reject') && source.includes('promise.resolve'), '结果必须回给 Promise');
});

test('app.json 已登记该插件（漏登记则 prebuild 不注入源码）', () => {
  const appJson = require('../app.json');
  assert.ok(appJson.expo.plugins.includes('./plugins/withShellExecutor'), 'app.json plugins 必须含 withShellExecutor');
});
