// Python 环境（Chaquopy 嵌入式 CPython）的预构建配置插件。
//
// 与 withShellExecutor / withLocalApiServer 同一套路：android/ 是 prebuild 生成的
// gitignored 目录，Kotlin 与 Python 源码保存在 plugins/chaquopy/android/，prebuild 时
// 拷进 android/ 并完成注册与 Gradle 接线。
//
// **已启用（2026-10-08）**，分两步走，现在在**第二步**：
//   第一步 = 最小原型（app.json 里 minimalPackages:true，只打解释器不装第三方包）
//     ——**真机已通过**：面板「运行时可用」，`print("hello from Python")` 输出被捕获、
//     退出码 0（第三轮才修好取值语义，见审查待办「第三次真机往返」）。
//   第二步 = 装第三方包（app.json 里 minimalPackages 改 false，即当前状态）：
//     pip 块带上 REAL_PACKAGES 的 5 个包。**待真机验证**。
// 分步的原因：Chaquopy 是 Gradle 级集成，expo export 不编译 Kotlin、本仓库的
// Node 测试也碰不到 Gradle，这条链路只能靠真机 APK 构建验证；而「Gradle 接线错」
// 与「pip 装包错」在日志里都是「构建失败」，一次装全了会分不清是哪一类。
// 第一步过了之后，第二步的失败基本只可能出在装包本身。
//
// 回退：把 minimalPackages 改回 true（回到已知可用的最小原型），或从 app.json 的
// expo.plugins 里删掉本插件（完全移除 Python），都不影响任何其它功能。
// 构建前后的走查清单见 SMOKE_TEST.md §16。
//
// 已按核实报告 §2.4 修正：Chaquopy 只能在构建时用 pip 块装包，**没有运行时 pip**，
// 所以这里只声明构建期依赖，界面侧不提供「装包/切镜像源」。
//
// 依赖版本：Chaquopy 16.1（支持 AGP 7.0–8.13；Expo SDK 54 用 AGP 8.x）。MIT 许可。

const {
  withAndroidManifest,
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

// 跑 Python 的服务在**独立进程**里（冒号前缀 = 应用私有进程）。
// 这不是优化，是这套方案能成立的前提：Chaquopy 没有中断能力，只有把脚本放在
// 另一个进程里，「停止脚本」才等于「杀掉那个进程」而不牵连 UI。见 PythonService.kt。
const SERVICE_CLASS = 'PythonService';
const SERVICE_PROCESS = ':python';

// 最小原型开关（由 app.json 的插件 prop `minimalPackages` 控制，默认 false）。
//
// 为什么需要它：Gradle 接线出错与 pip 装包出错，在日志里都是「构建失败」，
// 一次装全了再失败就分不清是哪一类。先只打解释器、pip 块留空，把变量收敛到一个。
// 用 prop 而不是环境变量：prop 写在 app.json 里看得见、改一处即可，也不依赖
// EAS 的环境变量配置（那是本环境无法验证的东西）。
const REAL_PACKAGES = [
  'requests==2.34.2',
  'charset-normalizer==3.5.2',
  'idna==3.20',
  'urllib3==2.8.0',
  'certifi==2026.7.22',
];

// 对外（测试与文档）始终是「真正要装进包的清单」，不随最小原型开关变化——
// 否则最小构建期间测试会以为依赖清单是空的。
const BUNDLED_PACKAGES = REAL_PACKAGES;

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

// AndroidManifest：声明 :python 服务（幂等）。
//
// 必须显式 android:process：漏了它服务就跑在主进程里，于是「停止脚本」会变成杀掉 UI 进程。
// 客户端会比对服务回报的 pid 与自己的 pid，一旦相同就**拒绝运行**（失败朝安全方向倒，
// 而不是留一个杀不掉的执行入口）——但那是运行期的兜底，这里写对才是正解。
function applyServiceDeclaration(manifest) {
  const application = (manifest.application || [])[0];
  if (!application) throw new Error('withChaquopy: AndroidManifest 里找不到 application 节点');
  application.service = application.service || [];
  const name = `${BRIDGE_PACKAGE}.${SERVICE_CLASS}`;
  const existing = application.service.find(item => item && item.$ && item.$['android:name'] === name);
  if (existing) {
    existing.$['android:process'] = SERVICE_PROCESS;
    return manifest;
  }
  application.service.push({
    $: {
      'android:name': name,
      'android:process': SERVICE_PROCESS,
      // 只给本应用绑定用。导出等于把「执行 Python 代码」变成一个外部可调用入口。
      'android:exported': 'false',
    },
  });
  return manifest;
}

// ---------- 预构建 mod ----------

// minimalPackages: true 时 pip 块整块省略（见 REAL_PACKAGES 上方说明）。
function withGradleApp(config, { minimalPackages = false } = {}) {
  return withAppBuildGradle(config, cfg => {
    if (cfg.modResults.language === 'groovy') {
      const withPlugin = applyChaquopyPlugin(cfg.modResults.contents);
      cfg.modResults.contents = applyChaquopyConfig(
        withPlugin,
        minimalPackages ? { packages: [] } : {}
      );
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

function withManifest(config) {
  return withAndroidManifest(config, cfg => {
    applyServiceDeclaration(cfg.modResults.manifest);
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

// 插件入口。app.json 里可传 props：
//   ["./plugins/withChaquopy", { "minimalPackages": true }]
// minimalPackages 用于「两步构建」的第一步：只打解释器、不装第三方包，
// 把 Gradle 接线问题与 pip 装包问题分开暴露（见 REAL_PACKAGES 上方说明）。
module.exports = function withChaquopy(config, props = {}) {
  const options = {
    minimalPackages: props && props.minimalPackages === true,
  };
  config = withGradleProject(config, options);
  config = withGradleApp(config, options);
  config = withManifest(config, options);
  config = withSources(config, options);
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
  SERVICE_CLASS,
  SERVICE_PROCESS,
  applyChaquopyPlugin,
  applyChaquopyConfig,
  applyProjectClasspath,
  applyMainApplicationPatch,
  applyServiceDeclaration,
};
