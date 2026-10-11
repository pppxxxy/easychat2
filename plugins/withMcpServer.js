const {
  withAndroidManifest,
  withAppBuildGradle,
  withDangerousMod,
} = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

// 内置 MCP Server（Kotlin + NanoHTTPD）的预构建配置插件。
// android/ 是 expo prebuild --clean 生成的 gitignored 目录，不能直接手改：
// Kotlin 源码保存在 plugins/mcpServer/android/，prebuild 时拷贝，并通过本插件完成
// Manifest 权限、Gradle 依赖与 MainApplication 包注册。
//
// 与 withLocalApiServer 的关系：同款套路、各自独立的包名与 ReactPackage。两边都要
// nanohttpd 依赖，applyGradleDependencies 按「已存在就不加」幂等处理（谁先跑都行）。
//
// 别忘了 .gitignore：`android/` 规则会连目录一起排除，新插件必须补
// `!plugins/mcpServer/android/` + `!plugins/mcpServer/android/**` 两行成对，
// 否则干净检出里读不到源码、APK 打不出来（tests/pluginKotlinTracked.test.mjs 钉住这条）。

const PACKAGE_ID = 'com.pppxxxy.easychat2';
const MCP_PACKAGE = `${PACKAGE_ID}.mcpserver`;
const PACKAGE_CLASS = 'McpServerPackage';
const NANOHTTPD_DEPENDENCY = 'implementation("org.nanohttpd:nanohttpd:2.3.1")';

// INTERNET：服务端本身不需要出网，但 run_shell / git / 云构建 / 子代理这些被 MCP 调用的
// 工具需要；权限已在其它插件里申请，这里补齐一份，保证单开本插件也能用。
const PERMISSIONS = ['android.permission.INTERNET'];

// ---------- 可独立测试的纯函数 ----------

function applyPermissions(manifest) {
  manifest['uses-permission'] = manifest['uses-permission'] || [];
  const existing = new Set(
    manifest['uses-permission'].map(p => p && p.$ && p.$['android:name'])
  );
  for (const name of PERMISSIONS) {
    if (!existing.has(name)) {
      manifest['uses-permission'].push({ $: { 'android:name': name } });
    }
  }
  return manifest;
}

function applyGradleDependencies(contents) {
  if (contents.includes('org.nanohttpd:nanohttpd')) return contents;
  return contents.replace(
    /dependencies\s*\{/,
    match => `${match}\n    ${NANOHTTPD_DEPENDENCY}`
  );
}

function applyMainApplicationPatch(contents) {
  const registered = new RegExp(`packages\\.add\\(${PACKAGE_CLASS}\\(\\)\\)|\\badd\\(${PACKAGE_CLASS}\\(\\)\\)`);
  if (registered.test(contents)) return contents;
  let out = contents.replace(
    /import expo\.modules\.ReactNativeHostWrapper/,
    `import expo.modules.ReactNativeHostWrapper\nimport ${MCP_PACKAGE}.${PACKAGE_CLASS}`
  );
  if (/return PackageList\(this\)\.packages/.test(out)) {
    out = out.replace(
      /return PackageList\(this\)\.packages/,
      `val packages = PackageList(this).packages\n            packages.add(${PACKAGE_CLASS}())\n            return packages`
    );
  } else if (/PackageList\(this\)\.packages\.apply\s*\{/.test(out)) {
    out = out.replace(
      /PackageList\(this\)\.packages\.apply\s*\{/,
      match => `${match}\n              add(${PACKAGE_CLASS}())`
    );
  }
  if (!registered.test(out)) {
    throw new Error('withMcpServer: MainApplication 补丁未生效');
  }
  return out;
}

// ---------- 预构建 mod ----------

function withManifest(config) {
  return withAndroidManifest(config, cfg => {
    applyPermissions(cfg.modResults.manifest);
    return cfg;
  });
}

function withGradle(config) {
  return withAppBuildGradle(config, cfg => {
    if (cfg.modResults.language === 'groovy') {
      cfg.modResults.contents = applyGradleDependencies(cfg.modResults.contents);
    }
    return cfg;
  });
}

function withSources(config) {
  return withDangerousMod(config, [
    'android',
    async cfg => {
      const projectRoot = cfg.modRequest.platformProjectRoot;
      const srcDir = path.join(__dirname, 'mcpServer', 'android');
      const destDir = path.join(
        projectRoot,
        'app', 'src', 'main', 'java',
        ...MCP_PACKAGE.split('.')
      );
      fs.mkdirSync(destDir, { recursive: true });
      for (const file of fs.readdirSync(srcDir)) {
        if (file.endsWith('.kt')) {
          fs.copyFileSync(path.join(srcDir, file), path.join(destDir, file));
        }
      }

      const mainAppPath = path.join(
        projectRoot, 'app', 'src', 'main', 'java',
        ...PACKAGE_ID.split('.'), 'MainApplication.kt'
      );
      const mainApp = fs.readFileSync(mainAppPath, 'utf8');
      fs.writeFileSync(mainAppPath, applyMainApplicationPatch(mainApp));
      return cfg;
    },
  ]);
}

module.exports = function withMcpServer(config) {
  config = withManifest(config);
  config = withGradle(config);
  config = withSources(config);
  return config;
};

// 供 node --test 直接断言的纯函数出口
module.exports.__testables = {
  PERMISSIONS,
  PACKAGE_CLASS,
  MCP_PACKAGE,
  NANOHTTPD_DEPENDENCY,
  applyPermissions,
  applyGradleDependencies,
  applyMainApplicationPatch,
};
