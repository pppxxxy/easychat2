// 命令执行原生模块（ShellExecutor）的预构建配置插件。
//
// 与 withLocalApiServer 同一套路：android/ 是 expo prebuild --clean 生成的
// gitignored 目录，不能直接手改——Kotlin 源码保存在 plugins/shellExecutor/android/，
// prebuild 时拷进 android/，并通过本插件把包注册进 MainApplication。
//
// 本模块**不需要任何新权限**：它只是起 /system/bin/sh 的子进程，工作目录限定在
// 应用私有工作区。因此这里没有 withAndroidManifest 的权限注入——但保留该 mod
// 的接线点，方便日后若真需要权限时集中在此声明（当前 PERMISSIONS 为空是有意的）。

const {
  withAppBuildGradle,
  withDangerousMod,
} = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const PACKAGE_ID = 'com.pppxxxy.easychat2';
const SHELL_PACKAGE = `${PACKAGE_ID}.shellexecutor`;
const PACKAGE_CLASS = 'ShellExecutorPackage';

// 空数组是刻意的：起子进程不需要任何 Manifest 权限。
const PERMISSIONS = [];

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

// 本模块不引入新依赖，但保留函数以便与 localApiServer 的插件结构一致（且可测）。
// 幂等：不重复插入。
function applyGradleDependencies(contents) {
  return contents;
}

function applyMainApplicationPatch(contents) {
  const registered = new RegExp(`packages\\.add\\(${PACKAGE_CLASS}\\(\\)\\)|\\badd\\(${PACKAGE_CLASS}\\(\\)\\)`);
  if (registered.test(contents)) return contents;
  let out = contents.replace(
    /import expo\.modules\.ReactNativeHostWrapper/,
    `import expo.modules.ReactNativeHostWrapper\nimport ${SHELL_PACKAGE}.${PACKAGE_CLASS}`
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
    throw new Error('withShellExecutor: MainApplication 补丁未生效');
  }
  return out;
}

// ---------- 预构建 mod ----------

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
      const srcDir = path.join(__dirname, 'shellExecutor', 'android');
      const destDir = path.join(
        projectRoot,
        'app', 'src', 'main', 'java',
        ...SHELL_PACKAGE.split('.')
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

module.exports = function withShellExecutor(config) {
  config = withGradle(config);
  config = withSources(config);
  return config;
};

// 供 node --test 直接断言的纯函数出口
module.exports.__testables = {
  PERMISSIONS,
  PACKAGE_CLASS,
  SHELL_PACKAGE,
  applyPermissions,
  applyGradleDependencies,
  applyMainApplicationPatch,
};
