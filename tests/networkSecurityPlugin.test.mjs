// 网络安全加固插件的**源码级**校验（本机没有 Kotlin 编译器，也没有 android/ 目录，
// 所以这里能断言的只有「文件存在、文本里有什么、纯函数行为」——native 行为未经验证）。
//
// 每条断言都对应一种「静默失效」：
//   · 插件不存在 / 没导出 config plugin 函数 ⇒ prebuild 既不拷源码也不注入调用；
//   · Kotlin 没真的关掉重定向 ⇒ 302 到 127.0.0.1 的绕过依旧成立；
//   · Kotlin 只 import 不调 setOkHttpClientFactory ⇒ 加固根本没装上；
//   · 网段字面量漏一段 ⇒ 漏掉一条即绕过路径（口径必须与 webFetch.js 同）；
//   · app.json 漏登记 ⇒ prebuild 完全不会跑这个插件；
//   · Kotlin 括号不配平 ⇒ Gradle 阶段才炸（历史踩过）。
//
// 复用 tests/helpers/kotlinStatic.mjs 的文本层检查（与 shellExecutorPlugin /
// localApiServerPlugin 同一套工具）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

import {
  checkBraceBalance,
  checkPackageConsistency,
  findUnusedImports,
  readAllKotlin,
  readKotlinFiles,
  stripComments,
} from './helpers/kotlinStatic.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const KOTLIN_DIR = path.join(ROOT, 'plugins', 'networkSecurity', 'android');
const KOTLIN_PACKAGE = 'com.pppxxxy.easychat2.networksecurity';
const PLUGIN_ID = './plugins/withNetworkSecurity';

const plugin = require('../plugins/withNetworkSecurity.js');

// SDK 53/54 的 MainApplication.kt 模板骨架（本仓 5 个先例都按这个形状打补丁）。
const SDK54_MAIN_APPLICATION = [
  'package com.pppxxxy.easychat2',
  '',
  'import android.app.Application',
  'import expo.modules.ApplicationLifecycleDispatcher',
  'import expo.modules.ReactNativeHostWrapper',
  '',
  'class MainApplication : Application(), ReactApplication {',
  '',
  '  override fun onCreate() {',
  '    super.onCreate()',
  '    SoLoader.init(this, OpenSourceMergedSoMapping)',
  '  }',
  '}',
  '',
].join('\n');

// 圆括号配平（helpers 的 checkBraceBalance 只管花括号，这里补上圆括号）。
function checkParenBalance(source) {
  const stripped = stripComments(source);
  let depth = 0;
  let inString = false;
  for (let i = 0; i < stripped.length; i += 1) {
    const ch = stripped[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
  }
  return depth;
}

test('插件存在、导出 config plugin 函数，且 __testables 齐全', () => {
  assert.equal(typeof plugin, 'function', 'withNetworkSecurity.js 必须导出一个函数');
  assert.equal(typeof plugin.__testables, 'object', '必须导出 __testables 供测试断言');
  const { PACKAGE_ID, NS_PACKAGE, INSTALLER_CLASS, INSTALL_CALL } = plugin.__testables;
  assert.equal(PACKAGE_ID, 'com.pppxxxy.easychat2');
  assert.equal(NS_PACKAGE, `${PACKAGE_ID}.networksecurity`);
  assert.equal(INSTALLER_CLASS, 'NetworkSecurityInstaller');
  assert.equal(INSTALL_CALL, 'NetworkSecurityInstaller.install(applicationContext)');
});

test('Kotlin 源码存在、包名一致、括号配平、无未使用导入', () => {
  const files = readKotlinFiles(KOTLIN_DIR).map(item => item.file);
  assert.deepEqual(files, ['NetworkSecurityInstaller.kt', 'PrivateNetworkGuardDns.kt']);
  assert.deepEqual(checkPackageConsistency(KOTLIN_DIR, KOTLIN_PACKAGE), []);
  for (const { file, source } of readKotlinFiles(KOTLIN_DIR)) {
    const { balance, errors } = checkBraceBalance(source);
    assert.equal(balance, 0, `${file} 花括号不平衡`);
    assert.deepEqual(errors, [], `${file} 有多余的 }`);
    assert.equal(checkParenBalance(source), 0, `${file} 圆括号不平衡`);
    assert.deepEqual(findUnusedImports(source), [], `${file} 有未使用导入`);
  }
});

test('Kotlin 真的关掉了自动跟随重定向（核心修复）', () => {
  const source = readAllKotlin(KOTLIN_DIR);
  assert.ok(source.includes('followRedirects(false)'), '必须有 followRedirects(false)');
  assert.ok(source.includes('followSslRedirects(false)'), '必须有 followSslRedirects(false)');
  // 不能写成 true（改写时最容易出的错就是把加固项改成放行）。
  assert.ok(!/followRedirects\(true\)/.test(source), 'followRedirects 不得为 true');
});

test('Kotlin 通过 setOkHttpClientFactory 注入（只 import 不算）', () => {
  const source = readAllKotlin(KOTLIN_DIR);
  assert.ok(source.includes('setOkHttpClientFactory'), '必须调用 OkHttpClientProvider.setOkHttpClientFactory');
  assert.ok(
    /OkHttpClientProvider\.setOkHttpClientFactory\(\s*object\s*:\s*OkHttpClientFactory/.test(source),
    'factory 必须是 OkHttpClientFactory 的实现（否则签名对不上）',
  );
  // 复用 RN 自己的 builder，避免丢 cookie 容器与 http 缓存。
  assert.ok(source.includes('OkHttpClientProvider.createClientBuilder(context)'),
    '必须在 RN 的 builder 上追加加固项');
});

test('DNS 复核的网段字面量与 JS 侧 webFetch.js 同口径', () => {
  const source = readAllKotlin(KOTLIN_DIR);
  // 逐条对应 src/plugins/webFetch.js 的 isPrivateHostInfo（IPv4/回环/链路本地/CGNAT/
  // 组播保留 + IPv6 回环/唯一本地/链路本地 + 云元数据 169.254.169.254）。
  for (const literal of ['127.', '10.', '192.168.', '172.', '169.254.', '::1']) {
    assert.ok(source.includes(literal), `网段字面量缺失：${literal}`);
  }
  for (const token of ['100.', 'fe80', 'fc00', 'fec0', 'ff00', '224', '0xffff']) {
    assert.ok(source.includes(token), `网段判定缺少 ${token}（与 webFetch.js 口径不一致）`);
  }
  assert.ok(source.includes('169.254.169.254'), '云元数据地址必须写明');
  // 同口径这件事必须在注释里写明，并指向 JS 侧文件，否则下一个人会各自漂移。
  assert.ok(source.includes('isPrivateHostInfo'), '注释必须指向 webFetch.js 的 isPrivateHostInfo');
  assert.ok(source.includes('src/plugins/webFetch.js'), '注释必须指向 src/plugins/webFetch.js');
});

test('MainApplication 补丁：注入到 onCreate（先于桥/模块创建）且幂等', () => {
  const once = plugin.__testables.applyMainApplicationPatch(SDK54_MAIN_APPLICATION);
  assert.match(
    once,
    /import com\.pppxxxy\.easychat2\.networksecurity\.NetworkSecurityInstaller/,
    '必须补 import',
  );
  assert.ok(once.includes('NetworkSecurityInstaller.install(applicationContext)'), '必须注入调用语句');
  const callAt = once.indexOf('install(applicationContext)');
  assert.ok(callAt > once.indexOf('override fun onCreate()'), '调用必须在 onCreate 内');
  assert.ok(callAt > once.indexOf('super.onCreate()'), '调用必须在 super.onCreate() 之后');
  // 顺序是安全关键：必须在任何原生模块（client 在构造时被定下）之前装上 factory。
  assert.ok(callAt < once.indexOf('SoLoader.init'), '必须在 onCreate 前段执行（早于其它初始化）');
  assert.equal(
    plugin.__testables.applyMainApplicationPatch(once),
    once,
    '重复应用必须幂等',
  );
});

test('MainApplication 模板不认识时明确抛错（不静默不生效）', () => {
  assert.throws(
    () => plugin.__testables.applyMainApplicationPatch('class MainApplication {\n}\n'),
    /MainApplication 补丁未生效|找不到 import 区|未找到 MainApplication\.onCreate/,
  );
  assert.throws(
    () => plugin.__testables.applyMainApplicationPatch('import a.b\nclass X {\n}\n'),
    /未找到 MainApplication\.onCreate/,
  );
});

test('app.json 的 expo.plugins 已登记本插件', () => {
  // 用 readFileSync('utf8') 显式读，避免依赖 JSON 加载器的编码行为。
  const raw = readFileSync(path.join(ROOT, 'app.json'), 'utf8');
  const appJson = JSON.parse(raw);
  assert.ok(Array.isArray(appJson.expo.plugins), 'expo.plugins 必须是数组');
  assert.ok(
    appJson.expo.plugins.includes(PLUGIN_ID),
    `app.json 的 expo.plugins 必须含 ${PLUGIN_ID}（漏登记则 prebuild 不注入加固）`,
  );
  assert.ok(raw.includes(`"${PLUGIN_ID}"`), 'app.json 原文里必须出现该插件路径');
});

// 真的把插件当成 Expo 会跑的模样执行一遍 dangerous mod（写到系统临时目录，不碰仓库）：
// 只有这一步能证明「Kotlin 会落到 prebuild 生成的包目录里」而不是只证明字符串对。
test('模拟 prebuild：dangerous mod 把 Kotlin 拷到包目录并改好 MainApplication', async () => {
  const projectRoot = mkdtempSync(path.join(os.tmpdir(), 'ns-plugin-'));
  try {
    const pkgDir = path.join(
      projectRoot, 'app', 'src', 'main', 'java',
      ...'com.pppxxxy.easychat2'.split('.')
    );
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(path.join(pkgDir, 'MainApplication.kt'), SDK54_MAIN_APPLICATION, 'utf8');

    const config = plugin({ name: 'easychat2', slug: 'easychat2' });
    const runDangerousMod = config.mods.android.dangerous;
    assert.equal(typeof runDangerousMod, 'function', '必须注册 android 的 dangerous mod');
    await runDangerousMod({ modRequest: { platformProjectRoot: projectRoot } });

    const destDir = path.join(pkgDir, 'networksecurity');
    const copied = readFileSync(path.join(destDir, 'NetworkSecurityInstaller.kt'), 'utf8');
    assert.ok(copied.includes('setOkHttpClientFactory'), 'Kotlin 必须被拷进 <包名>/networksecurity/');
    assert.ok(readFileSync(path.join(destDir, 'PrivateNetworkGuardDns.kt'), 'utf8').includes('isPrivateAddress'));

    const patched = readFileSync(path.join(pkgDir, 'MainApplication.kt'), 'utf8');
    assert.ok(
      patched.includes('NetworkSecurityInstaller.install(applicationContext)'),
      'MainApplication 必须被注入调用',
    );

    // 重跑一次（Expo 可能重入）：不得重复注入。
    await runDangerousMod({ modRequest: { platformProjectRoot: projectRoot } });
    const again = readFileSync(path.join(pkgDir, 'MainApplication.kt'), 'utf8');
    assert.equal(
      again.split('NetworkSecurityInstaller.install(applicationContext)').length - 1,
      1,
      '重跑不得重复注入调用',
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
