// 内置 MCP Server 的预构建插件 + Kotlin 静态体检。
//
// 沙箱里编不了 Kotlin、也跑不了 prebuild，所以这里拦两类「反馈链最长」的错误：
//  1) 插件纯函数（权限/依赖/MainApplication 补丁）——错了要等 gradle 才炸；
//  2) Kotlin 源码本身（括号、包名、未使用导入、以及「哑管道 + 强制 Bearer」这两条契约）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
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
const ROOT = path.join(HERE, '..');
const KOTLIN_DIR = path.join(ROOT, 'plugins', 'mcpServer', 'android');
const KOTLIN_PACKAGE = 'com.pppxxxy.easychat2.mcpserver';

const readAllKotlinSource = () => readAllKotlin(KOTLIN_DIR);

const plugin = require('../plugins/withMcpServer.js');
const {
  PERMISSIONS,
  PACKAGE_CLASS,
  MCP_PACKAGE,
  applyPermissions,
  applyGradleDependencies,
  applyMainApplicationPatch,
} = plugin.__testables;

function minimalManifest() {
  return { application: [{ $: { 'android:name': '.MainApplication' } }] };
}

test('权限清单含 INTERNET（被 MCP 调用的工具要出网）', () => {
  assert.ok(PERMISSIONS.includes('android.permission.INTERNET'));
  const manifest = applyPermissions(minimalManifest());
  assert.equal(manifest['uses-permission'].length, PERMISSIONS.length);
  applyPermissions(manifest);
  assert.equal(manifest['uses-permission'].length, PERMISSIONS.length, '幂等');
});

test('Gradle 依赖注入 nanohttpd 且幂等（与 withLocalApiServer 共存不重复加）', () => {
  const input = 'android {\n}\n\ndependencies {\n    implementation("com.facebook.react:react-android")\n}\n';
  const once = applyGradleDependencies(input);
  assert.match(once, /implementation\("org\.nanohttpd:nanohttpd:2\.3\.1"\)/);
  assert.equal(applyGradleDependencies(once), once);
  // 已经由 withLocalApiServer 加过就不再加第二次（谁先跑都行）
  const already = 'dependencies {\n    implementation("org.nanohttpd:nanohttpd:2.3.1")\n}\n';
  assert.equal(applyGradleDependencies(already), already);
});

test('MainApplication 补丁注册 McpServerPackage（两种模板）且幂等', () => {
  const sdk50 = [
    'import expo.modules.ReactNativeHostWrapper',
    '',
    '          override fun getPackages(): List<ReactPackage> {',
    '            return PackageList(this).packages',
    '          }',
  ].join('\n');
  const once = applyMainApplicationPatch(sdk50);
  assert.match(once, new RegExp(`import ${MCP_PACKAGE.replace(/\./g, '\\.')}\\.${PACKAGE_CLASS}`));
  assert.match(once, new RegExp(`packages\\.add\\(${PACKAGE_CLASS}\\(\\)\\)`));
  assert.equal(applyMainApplicationPatch(once), once);

  const sdk54 = [
    'import expo.modules.ReactNativeHostWrapper',
    '',
    '        override fun getPackages(): List<ReactPackage> =',
    '            PackageList(this).packages.apply {',
    '              // add(MyReactNativePackage())',
    '            }',
  ].join('\n');
  const applied = applyMainApplicationPatch(sdk54);
  assert.match(applied, new RegExp(`\\badd\\(${PACKAGE_CLASS}\\(\\)\\)`));
  assert.equal(applyMainApplicationPatch(applied), applied);

  assert.throws(
    () => applyMainApplicationPatch('import expo.modules.ReactNativeHostWrapper\n\noverride fun getPackages() = somethingElse()'),
    /补丁未生效/
  );
});

test('插件已登记进 app.json，源码目录含两个 Kotlin 文件', () => {
  assert.equal(typeof plugin({ name: 'x' }), 'object');
  const appJson = JSON.parse(readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
  assert.ok(appJson.expo.plugins.includes('./plugins/withMcpServer'), 'app.json 必须登记本插件');
  const files = readdirSync(KOTLIN_DIR).filter(f => f.endsWith('.kt'));
  assert.ok(files.includes('McpServerModule.kt'));
  assert.ok(files.includes('McpServerPackage.kt'));
});

test('Kotlin 源码大括号平衡（沙箱无法编译，防编辑遗留重复片段）', () => {
  for (const { file, source } of readKotlinFiles(KOTLIN_DIR)) {
    const { balance, errors } = checkBraceBalance(source);
    for (const error of errors) {
      assert.fail(`${file}:${error.line} ${error.message}`);
    }
    assert.equal(balance, 0, `${file} 大括号不平衡`);
  }
});

test('Kotlin 包名一致且无未使用导入', () => {
  for (const error of checkPackageConsistency(KOTLIN_DIR, KOTLIN_PACKAGE)) {
    assert.fail(`${error.file} ${error.message}`);
  }
  for (const { file, source } of readKotlinFiles(KOTLIN_DIR)) {
    const unused = findUnusedImports(source);
    assert.deepEqual(unused.map(item => item.name), [], `${file} 存在未使用导入：${unused.map(item => item.line).join(' / ')}`);
  }
});

test('Kotlin 顶层声明不重复定义', () => {
  for (const error of checkUniqueDeclarations(readAllKotlinSource(), ['class McpServerModule', 'class McpServerPackage'])) {
    assert.fail(error.message);
  }
});

test('Kotlin 契约：单端点 /mcp + 强制 Bearer + 哑管道（协议判断留在 JS）', () => {
  const source = readAllKotlinSource();
  assert.ok(source.includes('"/mcp"'), '只暴露 /mcp 端点');
  assert.ok(source.includes('authorization'), '读 Bearer 头');
  assert.ok(source.includes('UNAUTHORIZED'), '鉴权失败要 401');
  assert.ok(source.includes('MessageDigest.isEqual'), 'token 比较用恒定时间');
  assert.ok(source.includes('SecureRandom'), 'token 为空时自动生成（绝不放行匿名请求）');
  assert.ok(source.includes('Mcp-Session-Id') || source.includes('mcp-session-id'), '要转发会话头');
  assert.ok(source.includes('NetworkInterface'), '局域网地址由原生枚举（UI 拼连接配置用）');
  // 哑管道：协议方法名不该出现在 Kotlin 里（那是 JS 的职责，改了不用重编原生）
  for (const method of ['initialize', 'tools/list', 'tools/call', 'resources/read']) {
    assert.ok(!source.includes(`"${method}"`), `Kotlin 不得内联 MCP 方法名：${method}`);
  }
  // 回写接口必须能带 status 与响应头（会话 id 靠它下发）
  assert.match(source, /fun respond\(requestId: String, status: Int, headersJson: String, body: String/);
});

test('Kotlin 静态契约与 JS 桥一致：事件名、路径、超时', () => {
  const source = readAllKotlinSource();
  const bridge = readFileSync(path.join(ROOT, 'src', 'mcp', 'serverBridge.js'), 'utf8');
  assert.ok(source.includes('McpServer:onRequest'), '事件名');
  assert.ok(bridge.includes('McpServer:onRequest'), 'JS 侧监听同名事件');
  assert.ok(bridge.includes("'/mcp'") || bridge.includes('MCP_ENDPOINT_PATH'), 'JS 侧路径');
  // HTTP 等待必须长于工具层最长超时（run_subagent 300s），否则工具还在跑 HTTP 先断
  const timeout = Number((source.match(/REQUEST_TIMEOUT_MS = ([\d_]+)L/) || [])[1]?.replace(/_/g, ''));
  assert.ok(timeout >= 300_000, `HTTP 等待 ${timeout}ms 不得短于工具层 300s`);
});
