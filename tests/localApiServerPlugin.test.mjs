import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const KOTLIN_DIR = path.join(HERE, '..', 'plugins', 'localApiServer', 'android');

function readAllKotlin() {
  return readdirSync(KOTLIN_DIR)
    .filter(f => f.endsWith('.kt'))
    .map(f => readFileSync(path.join(KOTLIN_DIR, f), 'utf8'))
    .join('\n');
}

const plugin = require('../plugins/withLocalApiServer.js');
const {
  PERMISSIONS,
  PACKAGE_CLASS,
  applyPermissions,
  applyGradleDependencies,
  applyMainApplicationPatch,
} = plugin.__testables;

function minimalManifest() {
  return { application: [{ $: { 'android:name': '.MainApplication' } }] };
}

test('权限清单含 INTERNET', () => {
  assert.ok(PERMISSIONS.includes('android.permission.INTERNET'));
});

test('applyPermissions 能注入且幂等', () => {
  const manifest = applyPermissions(minimalManifest());
  assert.equal(manifest['uses-permission'].length, PERMISSIONS.length);
  applyPermissions(manifest);
  assert.equal(manifest['uses-permission'].length, PERMISSIONS.length);
});

test('Gradle 依赖注入 nanohttpd 且幂等', () => {
  const input = 'android {\n}\n\ndependencies {\n    implementation("com.facebook.react:react-android")\n}\n';
  const once = applyGradleDependencies(input);
  assert.match(once, /implementation\("org\.nanohttpd:nanohttpd:2\.3\.1"\)/);
  assert.equal(applyGradleDependencies(once), once);
});

test('MainApplication 补丁注册 LocalApiServerPackage（SDK 50 模板）且幂等', () => {
  const input = [
    'import expo.modules.ReactNativeHostWrapper',
    '',
    '          override fun getPackages(): List<ReactPackage> {',
    '            return PackageList(this).packages',
    '          }',
  ].join('\n');
  const once = applyMainApplicationPatch(input);
  assert.match(once, new RegExp(`import com\\.pppxxxy\\.easychat2\\.localapi\\.${PACKAGE_CLASS}`));
  assert.match(once, new RegExp(`packages\\.add\\(${PACKAGE_CLASS}\\(\\)\\)`));
  assert.equal(applyMainApplicationPatch(once), once);
});

test('MainApplication 补丁注册 LocalApiServerPackage（SDK 54 apply 模板）且幂等', () => {
  const input = [
    'import expo.modules.ReactNativeHostWrapper',
    '',
    '        override fun getPackages(): List<ReactPackage> =',
    '            PackageList(this).packages.apply {',
    '              // add(MyReactNativePackage())',
    '            }',
  ].join('\n');
  const once = applyMainApplicationPatch(input);
  assert.match(once, new RegExp(`import com\\.pppxxxy\\.easychat2\\.localapi\\.${PACKAGE_CLASS}`));
  assert.match(once, new RegExp(`\\badd\\(${PACKAGE_CLASS}\\(\\)\\)`));
  assert.equal(applyMainApplicationPatch(once), once);
});

test('MainApplication 模板无法识别时抛错，不静默放行', () => {
  const input = [
    'import expo.modules.ReactNativeHostWrapper',
    '',
    '        override fun getPackages(): List<ReactPackage> = somethingElse()',
  ].join('\n');
  assert.throws(() => applyMainApplicationPatch(input), /补丁未生效/);
});

test('插件本体返回 config 对象，源码目录含 Kotlin', () => {
  assert.equal(typeof plugin({ name: 'x' }), 'object');
  const files = readdirSync(KOTLIN_DIR).filter(f => f.endsWith('.kt'));
  assert.ok(files.includes('LocalApiServerModule.kt'));
  assert.ok(files.includes('LocalApiServerPackage.kt'));
});

test('Kotlin 源码大括号平衡（沙箱无法编译，防编辑遗留重复片段）', () => {
  for (const file of readdirSync(KOTLIN_DIR).filter(f => f.endsWith('.kt'))) {
    const source = readFileSync(path.join(KOTLIN_DIR, file), 'utf8');
    let balance = 0;
    let inString = false;
    let inTriple = false;
    for (let i = 0; i < source.length; i += 1) {
      const ch = source[i];
      if (!inString && !inTriple && source.slice(i, i + 3) === '"""') {
        inTriple = true;
        i += 2;
        continue;
      }
      if (inTriple && source.slice(i, i + 3) === '"""') {
        inTriple = false;
        i += 2;
        continue;
      }
      if (inTriple) continue;
      if (!inString && ch === '"') {
        inString = true;
        continue;
      }
      if (inString) {
        if (ch === '\\') i += 1;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '{') balance += 1;
      else if (ch === '}') balance -= 1;
      assert.ok(balance >= 0, `${file} 出现多余的 }`);
    }
    assert.equal(balance, 0, `${file} 大括号不平衡`);
  }
});

test('Kotlin 顶层声明不重复定义', () => {
  const source = readAllKotlin();
  for (const keyword of ['class LocalApiServerModule', 'class LocalApiServerPackage']) {
    const count = source.split(keyword).length - 1;
    assert.equal(count, 1, `${keyword} 应恰好定义一次，实际 ${count}`);
  }
});

test('Kotlin 服务契约：仅回环、Bearer、JSON 字符串编组、事件与回写', () => {
  const source = readAllKotlin();
  assert.ok(source.includes('127.0.0.1'), '应绑定回环地址');
  assert.ok(source.includes('/v1/chat/completions'), '缺少 chat completions 路由');
  assert.ok(source.includes('/v1/models'), '缺少 models 路由');
  assert.ok(source.includes('authorization'), '缺少 Bearer 头读取');
  assert.ok(source.includes('UNAUTHORIZED'), '缺少鉴权失败响应');
  // JSON 字符串契约：事件与回写都用 String
  assert.ok(source.includes('LocalApiServer:onRequest'), '缺少请求事件名');
  assert.match(source, /fun respond\(requestId: String, responseJson: String, promise: Promise\)/);
  assert.ok(source.includes('CountDownLatch'), '缺少等待 JS 回写的同步原语');
  // 生命周期
  assert.ok(source.includes('addListener') && source.includes('removeListeners'));
  assert.ok(source.includes('onCatalystInstanceDestroy'));
  assert.ok(source.includes('NanoHTTPD'));
});

test('Kotlin 嵌套类型/静态方法正确限定（外层类不继承 NanoHTTPD）', () => {
  const module = readFileSync(path.join(KOTLIN_DIR, 'LocalApiServerModule.kt'), 'utf8');
  // 外层 LocalApiServerModule 不继承 NanoHTTPD，Response/IHTTPSession/Method 必须 import 或限定，
  // 否则 Kotlin 编译报 Unresolved reference；静态 newFixedLengthResponse 必须带 NanoHTTPD. 前缀。
  for (const nested of ['NanoHTTPD.Response', 'NanoHTTPD.IHTTPSession', 'NanoHTTPD.Method']) {
    assert.ok(module.includes(`import fi.iki.elonen.${nested}`), `缺少 ${nested} import`);
  }
  assert.ok(module.includes('NanoHTTPD.newFixedLengthResponse'), '静态工厂应带 NanoHTTPD. 前缀');
  assert.equal(
    /(?<!NanoHTTPD\.)newFixedLengthResponse\(/.test(module),
    false,
    'newFixedLengthResponse 不得裸调用'
  );
});

test('Kotlin 外层方法引用的字段必须挂在模块类上（inner 属性外层不可见）', () => {
  const module = readFileSync(path.join(KOTLIN_DIR, 'LocalApiServerModule.kt'), 'utf8');
  // handle/checkAuth/buildCompletion 是外层方法，引用的 apiKey/modelId 必须是外层字段；
  // 曾放在 inner ApiServer 构造属性里，Kotlin 编译会 Unresolved reference（沙箱无编译器，只能结构兜底）。
  assert.match(module, /private var apiKey: String/, 'apiKey 应为外层字段');
  assert.match(module, /private var modelId: String/, 'modelId 应为外层字段');
  // ApiServer 构造不再携带 apiKey/modelId（inner 属性外层方法拿不到）
  assert.match(module, /ApiServer\(HOST, port\)/, 'ApiServer 应只接 host/port');
  // start() 必须先写入外层字段再建 server
  assert.match(module, /this\.apiKey = [\s\S]*?ApiServer\(HOST, port\)/);
});

test('Kotlin 鉴权：免鉴权放行已移除，空密钥自动生成，比较恒定时间', () => {
  const module = readFileSync(path.join(KOTLIN_DIR, 'LocalApiServerModule.kt'), 'utf8');
  // 旧的「空密钥放行」必须不复存在（同机任意 App 曾可匿名调用推理）
  assert.equal(
    /expected\.isEmpty\(\)\) return true/.test(module),
    false,
    '空密钥不得放行'
  );
  // checkAuth 对空密钥直接拒绝（双保险；start 保证非空）
  assert.match(module, /if \(expected\.isEmpty\(\)\) return false/, '空密钥应拒绝');
  // 恒定时间比较
  assert.match(module, /MessageDigest\.isEqual\(/, '应使用恒定时间比较');
  // 严格 Bearer 方案校验（scheme 大小写不敏感，但必须存在）
  assert.match(module, /equals\("bearer", ignoreCase = true\)/, '应严格校验 Bearer 方案');
  // 空密钥启动自动生成随机密钥（SecureRandom）并回显
  assert.match(module, /SecureRandom\(\)\.nextBytes/, '应用 SecureRandom 生成密钥');
  assert.match(module, /generateApiKey\(\)/, '空密钥启动应自动生成');
  assert.match(module, /map\.putString\("apiKey", apiKey\)/, '启动结果应回显生效密钥');
});
