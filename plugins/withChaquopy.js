// Python 环境（Chaquopy 嵌入式 CPython）的预构建配置插件。
//
// 与 withShellExecutor / withLocalApiServer 同一套路：android/ 是 prebuild 生成的
// gitignored 目录，Kotlin 与 Python 源码保存在 plugins/chaquopy/android/，prebuild 时
// 拷进 android/ 并完成注册与 Gradle 接线。
//
// **默认不启用**（app.json 的 plugins 里没有它）。原因：Chaquopy 是 Gradle 级集成，
// expo export 不编译 Kotlin、本仓库的 Node 测试也碰不到 Gradle——也就是说这条链路
// 只能靠真机 APK 构建验证。把它默认打开会让「下一次 APK 构建」成为唯一验证手段，
// 一旦 Gradle 配置有出入，整个 Android 构建失败、连带阻塞其余功能。因此：
//   想启用时，在 app.json 的 expo.plugins 里加一行 "./plugins/withChaquopy"，
//   然后**盯住那一次构建**；失败就删掉这一行回退（不影响任何其他功能）。
//
// 已按核实报告 §2.4 修正：Chaquopy 只能在构建时用 pip 块装包，**没有运行时 pip**，
// 所以这里只声明构建期依赖，界面侧不提供「装包/切镜像源」。
//
// 依赖版本：Chaquopy 16.1（支持 AGP 7.0–8.13；Expo SDK 54 用 AGP 8.x）。MIT 许可。

const {
  withAppBuildGradle,
  withProjectBuildGradle,
  withDangerousMod,
} = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const PACKAGE_ID = 'com.pppxxxy.easychat2';
const BRIDGE_PACKAGE = `${PACKAGE_ID}.pythonbridge`;
const PACKAGE_CLASS = 'PythonBridgePackage';
const CHAQUOPY_GRADLE_VERSION = '16.1.0';

// 构建时装进 APK 的包（pip 块）。改这里就要重新构建 APK 才生效。
//
// 依赖全部钉死且含传递依赖：Chaquopy 的 pip 走它自己的索引，不锁版本时
// 同一份源码在不同时间构建会装到不同版本（结果不可复现，也无法审计）。
//
// requests 版本选择依据（2026-10-08 在 OSV 核实）：
//   · CVE-2024-47081（.netrc 凭据泄露）修于 2.32.4；
//   · CVE-2026-25645（临时文件复用）修于 2.33.0。
// 原先钉的 2.31.0 两条都中，故升到 2.34.2（当前 PyPI 最新稳定版）。
// 传递依赖按 requests 2.34.2 的 requires_dist 取当前稳定版：
//   charset_normalizer<4,>=2 / idna<4,>=2.5 / urllib3<3,>=1.26 / certifi>=2023.5.7
const REAL_PACKAGES = [
  'requests==2.34.2',
  'charset-normalizer==3.5.2',
  'idna==3.20',
  'urllib3==2.8.0',
  'certifi==2026.7.22',
];

// 最小原型开关：`EASYCHAT2_PYTHON_MINIMAL=1` 时 pip 块留空，只验 Chaquopy 本身
// 能否把解释器打进去、能否初始化。
//
// 为什么需要它：Gradle 接线出错与 pip 装包出错，在日志里都是「构建失败」，
// 一次装全了再失败就分不清是哪一类。先空手跑通一次，把变量收敛到一个。
// 确认通过后去掉这个环境变量重新构建即可（清单会自动恢复）。
const MINIMAL_BUILD = String(process.env.EASYCHAT2_PYTHON_MINIMAL || '') === '1';
const BUNDLED_PACKAGES = MINIMAL_BUILD ? [] : REAL_PACKAGES;

// app 内 Python 版本：显式钉住，不吃 Chaquopy 的默认值（16.1 默认 3.8）。
// 选 3.13 的理由：16.1 支持 3.9–3.13，3.13 与 requests 2.34.x 要求的
// >=3.10 兼容；且本机 Python 3.13 满足 16.1 的 buildPython 要求（>=3.8）。
const PYTHON_VERSION = '3.13';
const BUILD_PYTHON = 'python3';

// 双 ABI 与 app.json 的 expo-build-properties buildArchs 对齐。
const ABI_FILTERS = ['arm64-v8a', 'x86_64'];

// ---------- 可独立测试的纯函数 ----------

// app/build.gradle：加 apply plugin（幂等）。
function applyChaquopyPlugin(contents) {
  if (/com\.chaquo\.python/.test(contents)) return contents;
  if (/^apply plugin: "com\.android\.application"$/m.test(contents)) {
    return contents.replace(
      /^(apply plugin: "com\.android\.application")$/m,
      '$1\napply plugin: "com.chaquo.python"'
    );
  }
  return `apply plugin: "com.chaquo.python"\n${contents}`;
}

// app/build.gradle：往 defaultConfig 里塞 ndk.abiFilters 与 python 块（幂等）。
// Chaquopy 要求显式 abiFilters；若文件里已有 abiFilters（例如 expo-build-properties
// 生成过），就不再插入我们这份，避免两处冲突。
//
// 语法：用**旧的嵌套 DSL**（android.defaultConfig.python{...}）。这不是将就——
// Chaquopy 15.0.1 引入顶层 chaquopy 块后明确写着「Kotlin 必须用新 DSL，
// Groovy 两种都能用」，且旧 DSL 在 16.1 未被弃用（changelog 的 Deprecations
// 段落只列了 minSdk 与 buildPython 门槛）。选旧 DSL 是因为它与
// withBuildProperties 注入的 android.defaultConfig 同处一块，插入点稳定。
function applyChaquopyConfig(contents, {
  packages = BUNDLED_PACKAGES,
  abiFilters = ABI_FILTERS,
  pythonVersion = PYTHON_VERSION,
  buildPython = BUILD_PYTHON,
} = {}) {
  if (/python\s*\{/.test(contents) && /com\.chaquo\.python/.test(contents)) return contents;
  const pipLines = packages.map(name => `                    install "${name}"`).join('\n');
  const ndkBlock = /abiFilters/.test(contents)
    ? ''
    : `            ndk {\n                abiFilters ${abiFilters.map(name => `"${name}"`).join(', ')}\n            }\n`;
  // 空清单时整块省略 pip：留一个空的 pip { } 块没有意义，也可能不被 Gradle 接受。
  const pipBlock = packages.length > 0
    ? ['                pip {', pipLines, '                }']
    : [];
  const pythonBlock = [
    '            python {',
    // 显式钉版本：不吃 Chaquopy 默认值，避免「换 Chaquopy 版本 → app 内 Python
    // 悄悄换版 → 已装的包没有对应 wheel」这种构建期才暴露的问题。
    `                version "${pythonVersion}"`,
    `                buildPython "${buildPython}"`,
    ...pipBlock,
    '            }',
    '',
  ].join('\n');
  const injected = `${ndkBlock}${pythonBlock}`;
  const match = contents.match(/^(\s*)defaultConfig\s*\{$/m);
  if (!match) throw new Error('withChaquopy: 找不到 defaultConfig 块，无法注入 python 配置');
  const index = contents.indexOf(match[0]) + match[0].length;
  return `${contents.slice(0, index)}\n${injected}${contents.slice(index)}`;
}

// android/build.gradle：buildscript 依赖里加 Chaquopy 的 Gradle 插件 classpath（幂等）。
function applyProjectClasspath(contents, { version = CHAQUOPY_GRADLE_VERSION } = {}) {
  if (/com\.chaquo\.python:gradle/.test(contents)) return contents;
  const line = `        classpath("com.chaquo.python:gradle:${version}")`;
  const match = contents.match(/^(\s*)dependencies\s*\{$/m);
  if (!match) throw new Error('withChaquopy: 找不到 buildscript dependencies 块，无法加入 classpath');
  const index = contents.indexOf(match[0]) + match[0].length;
  return `${contents.slice(0, index)}\n${line}${contents.slice(index)}`;
}

// MainApplication：注册 PythonBridgePackage（与 shellExecutor 同一套纯函数模式）。
function applyMainApplicationPatch(contents) {
  const registered = new RegExp(`packages\\.add\\(${PACKAGE_CLASS}\\(\\)\\)|\\badd\\(${PACKAGE_CLASS}\\(\\)\\)`);
  if (registered.test(contents)) return contents;
  let out = contents.replace(
    /import expo\.modules\.ReactNativeHostWrapper/,
    `import expo.modules.ReactNativeHostWrapper\nimport ${BRIDGE_PACKAGE}.${PACKAGE_CLASS}`
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
    throw new Error('withChaquopy: MainApplication 补丁未生效');
  }
  return out;
}

// ---------- 预构建 mod ----------

function withGradleApp(config) {
  return withAppBuildGradle(config, cfg => {
    if (cfg.modResults.language === 'groovy') {
      let contents = applyChaquopyPlugin(cfg.modResults.contents);
      contents = applyChaquopyConfig(contents);
      cfg.modResults.contents = contents;
    }
    return cfg;
  });
}

function withGradleProject(config) {
  return withProjectBuildGradle(config, cfg => {
    if (cfg.modResults.language === 'groovy') {
      cfg.modResults.contents = applyProjectClasspath(cfg.modResults.contents);
    }
    return cfg;
  });
}

function withSources(config) {
  return withDangerousMod(config, [
    'android',
    async cfg => {
      const projectRoot = cfg.modRequest.platformProjectRoot;
      const srcDir = path.join(__dirname, 'chaquopy', 'android');

      // Kotlin 桥
      const kotlinDest = path.join(projectRoot, 'app', 'src', 'main', 'java', ...BRIDGE_PACKAGE.split('.'));
      fs.mkdirSync(kotlinDest, { recursive: true });
      for (const file of fs.readdirSync(srcDir)) {
        if (file.endsWith('.kt')) {
          fs.copyFileSync(path.join(srcDir, file), path.join(kotlinDest, file));
        }
      }

      // Python 辅助模块（Chaquopy 默认从 app/src/main/python 加载）
      const pythonSrc = path.join(srcDir, 'python');
      const pythonDest = path.join(projectRoot, 'app', 'src', 'main', 'python');
      fs.mkdirSync(pythonDest, { recursive: true });
      for (const file of fs.readdirSync(pythonSrc)) {
        if (file.endsWith('.py')) {
          fs.copyFileSync(path.join(pythonSrc, file), path.join(pythonDest, file));
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

module.exports = function withChaquopy(config) {
  config = withGradleProject(config);
  config = withGradleApp(config);
  config = withSources(config);
  return config;
};

// 供 node --test 直接断言的纯函数出口
module.exports.__testables = {
  BUNDLED_PACKAGES,
  ABI_FILTERS,
  CHAQUOPY_GRADLE_VERSION,
  PYTHON_VERSION,
  BUILD_PYTHON,
  BRIDGE_PACKAGE,
  PACKAGE_CLASS,
  applyChaquopyPlugin,
  applyChaquopyConfig,
  applyProjectClasspath,
  applyMainApplicationPatch,
};
